import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import '../extension/markdown.js'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-'))
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'admin-pass'
const { app } = await import('./app.ts')
const { db } = await import('./db.ts')
const { purge, repoName } = await import('./app.ts')
// a real PNG signature plus padding up to n bytes
const png = (n = 16) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b }

// one sequential story: later tests reuse what earlier ones created
type Opts = { cookie?: string; token?: string; body?: unknown; form?: FormData; method?: string; headers?: Record<string, string> }
async function call(url: string, { cookie, token, body, form, method, headers: extra }: Opts = {}) {
  const headers: Record<string, string> = { ...extra }
  if (cookie) headers.cookie = cookie
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await app.request(url, { method: method ?? (body || form ? 'POST' : 'GET'), headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) })
  return { status: res.status, res, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
}
const login = async (email: string, password: string) => {
  const r = await call('/api/login', { body: { email, password } })
  expect(r.status).toBe(200)
  return r.res.headers.get('set-cookie')!.split(';')[0]
}

let admin = '', token = '', accountId = '', member = '', pullId = ''

describe('reviews42', () => {
  beforeAll(async () => { admin = await login('admin@example.com', 'admin-pass') })

  it('rejects a wrong password and anonymous API calls', async () => {
    expect((await call('/api/login', { body: { email: 'admin@example.com', password: 'nope' } })).status).toBe(401)
    expect((await call('/api/dashboard')).status).toBe(401)
    expect((await call('/api/me')).data).toEqual({ user: null })
  })

  it('bootstraps the first admin with an account', async () => {
    const d = (await call('/api/dashboard', { cookie: admin })).data
    expect(d.accounts).toHaveLength(1)
    expect(d.accounts[0].role).toBe('owner')
    expect(d.retention_days).toBe(30)
    accountId = d.accounts[0].id
  })

  it('invites a member who signs up through the link', async () => {
    const { token: inv } = (await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { email: 'Dev@Example.com' } })).data
    expect((await call(`/api/invites/${inv}`)).data).toMatchObject({ email: 'dev@example.com', exists: false })
    expect((await call(`/api/invites/${inv}/accept`, { body: { name: 'Dev', password: 'short' } })).status).toBe(400)
    const ok = await call(`/api/invites/${inv}/accept`, { body: { name: 'Dev', password: 'dev-password' } })
    expect(ok.status).toBe(200)
    member = ok.res.headers.get('set-cookie')!.split(';')[0]
    expect((await call(`/api/invites/${inv}`)).status).toBe(404)
    const acc = (await call(`/api/accounts/${accountId}`, { cookie: member })).data
    expect(acc.role).toBe('member')
    expect(acc.invites).toEqual([])
    expect((await call(`/api/accounts/${accountId}/invites`, { cookie: member, body: { email: 'x@y.z' } })).status).toBe(403)
  })

  it('issues tokens shown once', async () => {
    token = (await call('/api/tokens', { cookie: admin, body: { name: 'laptop' } })).data.token
    expect(token).toMatch(/^r42_/)
    const list = (await call('/api/tokens', { cookie: admin })).data
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(token)
    expect((await call('/api/v1/me', { token })).data.user.email).toBe('admin@example.com')
    const me = (await call('/api/me', { cookie: admin })).data
    expect(me).toMatchObject({ tokens: 1, accounts: [{ role: 'owner' }] })
    expect((await call('/api/me', { cookie: member })).data.tokens).toBe(0)
    expect((await call('/api/v1/me', { token: 'r42_wrong' })).status).toBe(401)
  })

  it('uploads annotations with files and links attachment: references', async () => {
    const form = new FormData()
    form.set('payload', new File([JSON.stringify({
      title: 'Add login', head_sha: 'abc123', summary: 'Overview ![shot](attachment:login.png)',
      annotations: [
        { path: 'app/login.ts', title: 'New file', body: 'Why it exists' },
        { path: 'app/routes.ts', line: 12, end_line: 14, body: 'Before/after ![x](attachment:login.png)' },
        { path: 'app/old.ts', line: 3, side: 'LEFT', body: 'Removed' },
      ],
    })], 'payload.json', { type: 'application/json' }))
    form.append('file', new File([png()], 'login.png', { type: 'image/png' }))
    const r = await call('/api/v1/pulls/acme/web/42', { token, form, method: 'PUT' })
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ annotations: 3, files: 1 })
    pullId = r.data.id
    const p = (await call('/api/v1/pulls/acme/web/42', { token })).data
    expect(p.annotations[1]).toMatchObject({ line: 12, end_line: 14, side: 'RIGHT' })
    expect(p.annotations[2].side).toBe('LEFT')
    expect(p.summary).toContain(`/files/${pullId}/login.png`)
    const img = await call(`/files/${pullId}/login.png`, { token })
    expect(img.status).toBe(200)
    expect(img.res.headers.get('content-security-policy')).toBe('sandbox')
    expect((await call(`/files/${pullId}/login.png`)).status).toBe(404)
  })

  it('replaces annotations on a re-run, keeping the same pull', async () => {
    const r = await call('/api/v1/pulls/acme/web/42', { token, method: 'PUT', body: { annotations: [{ path: 'a.ts', line: 1, body: 'only one' }] } })
    expect(r.data.id).toBe(pullId)
    const p = (await call(`/api/pulls/${pullId}`, { cookie: member })).data
    expect(p.annotations).toHaveLength(1)
    expect(p.files).toEqual([])
    expect((await call('/api/v1/pulls/acme/web/42', { token, method: 'PUT', body: { annotations: [{ body: 'no path' }] } })).status).toBe(400)
    expect((await call('/api/v1/pulls/acme/web/0', { token, method: 'PUT', body: { annotations: [] } })).status).toBe(400)
  })

  it('keeps same-named uploads apart and every stored file reachable', async () => {
    const long = `${'a'.repeat(96)}.png`, form = new FormData()
    form.set('payload', JSON.stringify({ annotations: [] }))
    form.append('file', new File([png()], long))
    form.append('file', new File([png(20)], long))
    const r = await call('/api/v1/pulls/acme/web/42', { token, form, method: 'PUT' })
    expect(r.data.files).toBe(2)
    const p = (await call(`/api/pulls/${pullId}`, { cookie: member })).data
    expect(p.files).toHaveLength(2)
    for (const f of p.files) expect((await call(f.url, { token })).status).toBe(200)
    expect((await call('/api/v1/pulls/acme/web/42', { token, method: 'PUT', body: null })).status).toBe(400)
  })

  it('hides pull requests from people outside the account', async () => {
    const other = (await call('/api/accounts', { cookie: admin, body: { name: 'Other' } })).data
    const { token: t } = (await call(`/api/accounts/${other.id}/invites`, { cookie: admin, body: { email: 'out@example.com' } })).data
    const outsider = (await call(`/api/invites/${t}/accept`, { body: { password: 'outsider-pass' } })).res.headers.get('set-cookie')!.split(';')[0]
    expect((await call('/api/v1/pulls/acme/web/42', { cookie: outsider })).status).toBe(404)
    expect((await call(`/api/pulls/${pullId}`, { cookie: outsider })).status).toBe(404)
    expect((await call(`/api/accounts/${accountId}`, { cookie: outsider })).status).toBe(404)
    expect((await call('/api/dashboard', { cookie: outsider })).data.pulls).toEqual([])
    // a member elsewhere can't connect it, and an owner elsewhere gets their own acme/web, never acme's notes
    expect((await call('/api/v1/pulls/acme/web/42', { cookie: outsider, method: 'PUT', body: { annotations: [] } })).status).toBe(403)
    const mine = (await call('/api/accounts', { cookie: outsider, body: { name: 'Mine' } })).data
    const put = await call('/api/v1/pulls/acme/web/42', { cookie: outsider, method: 'PUT', body: { annotations: [{ path: 'x', body: 'mine' }] } })
    expect(put.status).toBe(200)
    expect(put.data.id).not.toBe(pullId)
    expect((await call(`/api/pulls/${pullId}`, { cookie: member })).data.annotations).toEqual([])
    expect((await call('/api/v1/pulls/acme/web/42', { cookie: outsider })).data.annotations[0].body).toBe('mine')
    expect((await call(`/api/accounts/${mine.id}`, { cookie: outsider, method: 'DELETE' })).status).toBe(200)
  })

  it('keeps tokens to annotations and files, and cookie writes to this site', async () => {
    expect((await call('/api/tokens', { token })).status).toBe(401)
    expect((await call('/api/tokens', { token, body: { name: 'x' } })).status).toBe(401)
    expect((await call('/api/password', { token, method: 'PUT', body: { current: 'x', password: 'yyyyyyyy' } })).status).toBe(401)
    expect((await call('/api/v1/me', { token })).status).toBe(200)
    const cross = await call('/api/tokens', { cookie: admin, body: { name: 'x' }, headers: { 'sec-fetch-site': 'same-site' } })
    expect(cross.status).toBe(403)
    expect((await call('/api/tokens', { cookie: admin, body: { name: 'x' }, headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
  })

  it('connects repositories by name', async () => {
    expect((await call(`/api/accounts/${accountId}/repositories`, { cookie: admin, body: { full_name: 'not a repo' } })).status).toBe(400)
    expect((await call(`/api/accounts/${accountId}/repositories`, { cookie: admin, body: { full_name: 'https://github.com/acme/api' } })).status).toBe(200)
    expect((await call(`/api/accounts/${accountId}/repositories`, { cookie: admin, body: { full_name: 'acme/web' } })).status).toBe(409)
    const repos = (await call(`/api/accounts/${accountId}`, { cookie: member })).data.repositories
    expect(repos.map((r: { full_name: string }) => r.full_name)).toEqual(['acme/api', 'acme/web'])
  })

  it('accepts only real images and UTF-8 text up to 1 MB, and serves text as plain text', async () => {
    const up = async (...files: File[]) => {
      const form = new FormData()
      form.set('payload', JSON.stringify({ annotations: [{ path: 'r.md', body: 'see [report](attachment:report.md)' }] }))
      for (const f of files) form.append('file', f)
      return call('/api/v1/pulls/acme/web/43', { token, form, method: 'PUT' })
    }
    const gif = new File([new TextEncoder().encode('GIF89a......')], 'anim.gif')
    const ok = await up(gif, new File(['# Report\n| a | b |'], 'report.md'), new File(['a,b\n1,2'], 'data.csv'), new File(['hi'], 'notes.txt'), new File(['<button onclick="this.textContent++">0</button>'], 'demo.html'))
    expect(ok.status).toBe(200)
    const p = (await call('/api/v1/pulls/acme/web/43', { token })).data
    expect(p.files.map((f: { name: string; type: string }) => `${f.name}:${f.type}`).sort())
      .toEqual(['anim.gif:image/gif', 'data.csv:text/csv', 'demo.html:text/html', 'notes.txt:text/plain', 'report.md:text/markdown'])
    expect(p.annotations[0].body).toContain(`/files/${p.id}/report.md`)
    const md = await call(`/files/${p.id}/report.md`, { token })
    expect(md.res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(md.res.headers.get('content-security-policy')).toBe('sandbox')
    // revalidated, never cached blind: a re-upload keeps the name
    expect(md.res.headers.get('cache-control')).toBe('private, no-cache')
    expect((await call(`/files/${p.id}/report.md`, { token, headers: { 'if-none-match': md.res.headers.get('etag')! } })).status).toBe(304)
    // HTML demos run only in an opaque sandbox with every network request blocked
    // …and only when framed: opened as a page of its own it is source text, so it can't pose as this site
    expect((await call(`/files/${p.id}/demo.html`, { token })).res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const demo = await call(`/files/${p.id}/demo.html`, { token, headers: { 'sec-fetch-dest': 'iframe' } })
    expect(demo.res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const csp = demo.res.headers.get('content-security-policy')!
    expect(csp).toMatch(/^sandbox allow-scripts;/)
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain("default-src 'none'")
    // one etag per variant (a cache must never revalidate the framed html into a page); weak etags from a proxy match too
    expect(demo.res.headers.get('etag')).not.toBe((await call(`/files/${p.id}/demo.html`, { token })).res.headers.get('etag'))
    expect((await call(`/files/${p.id}/report.md`, { token, headers: { 'if-none-match': `"x", W/${md.res.headers.get('etag')}` } })).status).toBe(304)
    expect((await call(`/files/${p.id}/anim.gif`, { token })).res.headers.get('content-type')).toBe('image/gif')
    // refused: wrong extension, fake image, binary text, too big; a refused upload keeps the previous files
    expect((await up(new File(['<svg onload=alert(1)>'], 'x.svg'))).status).toBe(415)
    expect((await up(new File(['alert(1)'], 'x.js'))).status).toBe(415)
    expect((await up(new File(['not a png'], 'fake.png'))).status).toBe(415)
    expect((await up(new File([new Uint8Array([0x41, 0, 0x42])], 'bin.txt'))).status).toBe(415)
    expect((await up(new File([new Uint8Array([0xff, 0xfe, 0xfd])], 'latin.txt'))).status).toBe(415)
    expect((await up(new File([png(1024 * 1024 + 1)], 'big.png'))).status).toBe(413)
    expect((await call('/api/v1/pulls/acme/web/43', { token })).data.files).toHaveLength(5)
    expect((await call('/api/v1/pulls/acme/web/43', { token, method: 'DELETE' })).status).toBe(200)
  })

  it('takes GitLab (nested groups, self-hosted) and Bitbucket repositories as host/path', async () => {
    expect(repoName('https://gitlab.com/Acme/Platform/API.git')).toBe('gitlab.com/Acme/Platform/API')
    expect(repoName('git@bitbucket.org:team/app.git')).toBe('bitbucket.org/team/app')
    expect(repoName('https://GitLab.Acme.dev:8443/a/b/')).toBe('gitlab.acme.dev:8443/a/b')
    expect(repoName('https://github.com/rails/rails')).toBe('rails/rails')
    const body = { annotations: [{ path: 'a.ts', line: 1, body: 'why' }] }
    for (const repo of ['gitlab.com/acme/platform/api', 'bitbucket.org/team/app', 'gitlab.acme.dev:8443/a/b']) {
      expect((await call(`/api/v1/pulls/${repo}/7`, { token, body, method: 'PUT' })).status).toBe(200)
      const got = await call(`/api/v1/pulls/${repo}/7`, { token })
      expect(got.data.repository).toBe(repo)
      expect(got.data.annotations[0].body).toBe('why')
    }
    // GitHub's owner/name route is unchanged; nothing leaks across hosts with the same path
    expect((await call('/api/v1/pulls/acme/platform/7', { token })).status).toBe(404)
    for (const bad of ['gitlab.com/onlyone', 'gitlab.com/%2E%2E/x', 'bad host.com/a/b', 'gitlab.com/a/b c'])
      expect((await call(`/api/v1/pulls/${bad}/7`, { token, body, method: 'PUT' })).status).toBeGreaterThanOrEqual(400)
    expect((await call(`/api/accounts/${accountId}/repositories`, { cookie: admin, body: { full_name: 'https://bitbucket.org/team/web' } })).status).toBe(200)
    const repos = (await call(`/api/accounts/${accountId}`, { cookie: admin })).data.repositories.map((r: { full_name: string }) => r.full_name)
    expect(repos).toContain('bitbucket.org/team/web')
    for (const r of (await call(`/api/accounts/${accountId}`, { cookie: admin })).data.repositories as { id: string; full_name: string }[])
      if (r.full_name.includes('.')) expect((await call(`/api/repositories/${r.id}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
  })

  it('purges expired pull requests with their files', async () => {
    db.prepare('update pulls set expires_at = ? where id = ?').run('2000-01-01T00:00:00.000Z', pullId)
    expect(await purge()).toBe(1)
    expect(db.prepare('select count(*) as n from files where pull_id = ?').get(pullId)).toEqual({ n: 0 })
    expect((await call('/api/v1/pulls/acme/web/42', { token })).status).toBe(404)
  })

  it('serves the skill with the host filled in', async () => {
    const r = await call('http://r42.test/skill/SKILL.md')
    expect(r.data).toContain('http://r42.test')
    expect((await call('http://r42.test/install.sh')).data).toContain('http://r42.test/skill/SKILL.md')
  })

  it('renders Markdown without letting a later pass rewrite inside generated tags', async () => {
    const md = (globalThis as unknown as { r42Markdown: (s: string) => string }).r42Markdown
    expect(md('![x](http://a/[y](/x/onerror=alert``//))')).not.toContain('<a href')
    expect(md('[*a](http://x/*b)')).toContain('href="http://x/*b"')
    // hostile input stays cheap: deep quotes don't overflow the stack, long lines under a pipe don't backtrack
    expect(md('>'.repeat(5000) + ' x')).toContain('<blockquote>')
    const t = performance.now()
    md(`a | b\n${' '.repeat(19_990)}x`)
    expect(performance.now() - t).toBeLessThan(100)
    expect(md('| a | b |\n|---|:---:|\n| 1 | 2 |')).toContain('<td>2</td>')
    expect(md('use `a || b` here\n---')).toBe('<p>use <code>a || b</code> here</p><hr>')
    expect(md('the pipe |\n---')).toBe('<p>the pipe |</p><hr>')
  })

  it('reports 500s to BUGSINK_DSN with the route pattern only', async () => {
    const { report } = await import('./app.ts')
    const { vi } = await import('vitest')
    const sent = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())
    report(new Error('boom'), '/api/pulls/:id', 'GET')
    expect(sent).not.toHaveBeenCalled()
    process.env.BUGSINK_DSN = 'https://k3y@errors.dev/7'
    report(new Error('boom'), '/api/pulls/:id', 'GET')
    delete process.env.BUGSINK_DSN
    const [url, init] = sent.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://errors.dev/api/7/envelope/')
    expect((init.headers as Record<string, string>)['x-sentry-auth']).toContain('sentry_key=k3y')
    const event = JSON.parse(String(init.body).split('\n')[2])
    expect(event.transaction).toBe('GET /api/pulls/:id')
    sent.mockRestore()
  })

  it('lets admins manage people and repositories, members only read and upload', async () => {
    const acc = (await call(`/api/accounts/${accountId}`, { cookie: admin })).data
    const dev = acc.members.find((m: { email: string }) => m.email === 'dev@example.com')
    const owner = acc.members.find((m: { role: string }) => m.role === 'owner')
    expect((await call(`/api/accounts/${accountId}/repositories`, { cookie: member, body: { full_name: 'acme/members-cannot' } })).status).toBe(403)
    expect((await call(`/api/accounts/${accountId}/members/${dev.id}`, { cookie: admin, method: 'PUT', body: { role: 'owner' } })).status).toBe(400)
    expect((await call(`/api/accounts/${accountId}/members/${dev.id}`, { cookie: admin, method: 'PUT', body: { role: 'admin' } })).status).toBe(200)
    // now an admin: invites people, but can't touch the owner or themselves
    const inv = await call(`/api/accounts/${accountId}/invites`, { cookie: member, body: { email: 'new@example.com', role: 'admin' } })
    expect(inv.status).toBe(200)
    expect((await call(`/api/invites/${inv.data.token}`)).data.email).toBe('new@example.com')
    expect((await call(`/api/accounts/${accountId}/members/${owner.id}`, { cookie: member, method: 'PUT', body: { role: 'member' } })).status).toBe(400)
    expect((await call(`/api/accounts/${accountId}/members/${owner.id}`, { cookie: member, method: 'DELETE' })).status).toBe(400)
    expect((await call(`/api/accounts/${accountId}/members/${dev.id}`, { cookie: member, method: 'PUT', body: { role: 'member' } })).status).toBe(400)
    expect((await call(`/api/accounts/${accountId}`, { cookie: member, method: 'PUT', body: { name: 'Core team' } })).status).toBe(200)
    expect((await call(`/api/accounts/${accountId}`, { cookie: member, method: 'DELETE' })).status).toBe(403)
    expect((await call(`/api/accounts/${accountId}`, { cookie: admin })).data.account.name).toBe('Core team')
  })

  it('shows an account overview with storage per repository', async () => {
    const form = new FormData()
    form.set('payload', JSON.stringify({ title: 'Overview', annotations: [{ path: 'a.ts', line: 1, body: 'x' }, { path: 'b.ts', body: 'y' }] }))
    form.append('file', new File([png(10)], 'shot.png', { type: 'image/png' }))
    expect((await call('/api/v1/pulls/acme/web/7', { token, form, method: 'PUT' })).status).toBe(200)
    const o = (await call(`/api/accounts/${accountId}/overview`, { cookie: member })).data
    expect(o.totals).toMatchObject({ members: 2, admins: 2, repositories: 2, pulls: 1, annotations: 2, files: 1, bytes: 10 })
    expect(o.repositories.find((r: { repository: string }) => r.repository === 'acme/web')).toMatchObject({ pulls: 1, files: 1, bytes: 10 })
    expect(o.recent[0]).toMatchObject({ title: 'Overview', uploader: 'admin@example.com', annotations: 2 })
  })

  it('gives super admins server stats and every account, nobody else', async () => {
    expect((await call('/api/admin/stats', { cookie: member })).status).toBe(404)
    const st = (await call('/api/admin/stats', { cookie: admin })).data
    expect(st.totals).toMatchObject({ accounts: 2, pulls: 1, annotations: 2, upload_bytes: 10 })
    expect(st.totals.disk_free_bytes).toBeGreaterThan(0)
    expect(st.accounts.find((a: { name: string }) => a.name === 'Other').owner).toBe('admin@example.com')
    const dev = st.users.find((u: { email: string }) => u.email === 'dev@example.com')
    const me = st.users.find((u: { email: string }) => u.email === 'admin@example.com')
    expect((await call(`/api/admin/users/${me.id}`, { cookie: admin, method: 'PUT', body: { admin: false } })).status).toBe(400)
    expect((await call(`/api/admin/users/${dev.id}`, { cookie: admin, method: 'PUT', body: { admin: true } })).status).toBe(200)
    expect((await call('/api/admin/stats', { cookie: member })).status).toBe(200)
    // a super admin manages an account even where they are only a member
    expect((await call(`/api/accounts/${accountId}/members/${dev.id}`, { cookie: admin, method: 'PUT', body: { role: 'member' } })).status).toBe(200)
    expect((await call(`/api/accounts/${accountId}`, { cookie: member })).data.role).toBe('admin')
    expect((await call(`/api/admin/users/${dev.id}`, { cookie: admin, method: 'PUT', body: { admin: 'false' } })).status).toBe(200)
    expect((await call('/api/admin/stats', { cookie: member })).status).toBe(404)
  })

  it('lets the owner delete the account with its files', async () => {
    const other = (await call('/api/dashboard', { cookie: admin })).data.accounts.find((a: { name: string }) => a.name === 'Other')
    expect((await call(`/api/accounts/${other.id}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
    expect((await call(`/api/accounts/${other.id}`, { cookie: admin })).status).toBe(404)
  })

  it('stores files in an S3-compatible bucket when a super admin sets one up, and deletes them with the PR', async () => {
    const http = await import('node:http')
    const objects = new Map<string, Buffer>(), seen: string[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (d) => chunks.push(d)).on('end', () => {
        seen.push(`${req.method} ${req.url}`)
        if (!String(req.headers.authorization).startsWith('AWS4-HMAC-SHA256 Credential=KEY/')) { res.statusCode = 403; return res.end('unsigned') }
        if (req.method === 'PUT') objects.set(req.url!, Buffer.concat(chunks))
        if (req.method === 'DELETE') objects.delete(req.url!)
        if (req.method === 'GET' && !objects.has(req.url!)) res.statusCode = 404
        res.end(req.method === 'GET' ? objects.get(req.url!) : '')
      })
    }).listen(0)
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const cfg = { kind: 's3', endpoint, region: 'us-west-004', bucket: 'r42-files', key_id: 'KEY', secret: 'SECRET', prefix: 'prod' }
    expect((await call('/api/admin/storage', { cookie: member, method: 'PUT', body: cfg })).status).toBe(404)
    expect((await call('/api/admin/storage', { cookie: admin, method: 'PUT', body: { ...cfg, bucket: 'Bad_Bucket' } })).status).toBe(400)
    expect((await call('/api/admin/storage', { cookie: admin, method: 'PUT', body: cfg })).status).toBe(200)
    const st = (await call('/api/admin/storage', { cookie: admin })).data.storage
    expect(st).toMatchObject({ kind: 's3', bucket: 'r42-files', prefix: 'prod/', has_secret: true })
    expect(JSON.stringify(st)).not.toContain('SECRET')
    expect(JSON.stringify(db.prepare(`select value from settings where key = 'storage'`).get())).not.toContain('SECRET')

    const form = new FormData()
    form.set('payload', JSON.stringify({ annotations: [{ path: 'a.ts', body: '![x](attachment:s3.png)' }] }))
    form.append('file', new File([png(32)], 's3.png'))
    const up = await call('/api/v1/pulls/acme/web/44', { token, form, method: 'PUT' })
    expect(up.status).toBe(200)
    const key = `/r42-files/prod/pulls/${up.data.id}/s3.png`
    expect(objects.get(key)?.length).toBe(32)
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'uploads', up.data.id))).toBe(false)
    const img = await call(`/files/${up.data.id}/s3.png`, { token })
    expect(img.status).toBe(200)
    expect(img.res.headers.get('content-type')).toBe('image/png')

    // blank secret keeps the stored one; the lifecycle rule is a signed bucket-level PUT
    expect((await call('/api/admin/storage', { cookie: admin, method: 'PUT', body: { ...cfg, secret: '' } })).status).toBe(200)
    expect((await call('/api/admin/storage/lifecycle', { cookie: admin, body: {} })).data).toMatchObject({ ok: true, days: 31 })
    expect(seen).toContain('PUT /r42-files/?lifecycle=')
    // a prefix that would leave the key path, and moving the bucket while files live in it, are refused
    expect((await call('/api/admin/storage', { cookie: admin, method: 'PUT', body: { ...cfg, prefix: 'a#b' } })).status).toBe(400)
    expect((await call('/api/admin/storage', { cookie: admin, method: 'PUT', body: { ...cfg, bucket: 'other-bucket' } })).status).toBe(409)

    // back to disk: files already in the bucket still read, and still get deleted with their PR
    expect((await call('/api/admin/storage', { cookie: admin, method: 'PUT', body: { kind: 'disk' } })).status).toBe(200)
    expect((await call(`/files/${up.data.id}/s3.png`, { token })).status).toBe(200)
    db.prepare('update pulls set expires_at = ? where id = ?').run('2000-01-01T00:00:00.000Z', up.data.id)
    expect(await purge()).toBe(1)
    expect(objects.has(key)).toBe(false)
    server.close()
  })
})
