import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import '../extension/markdown.js'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-'))
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'admin-pass'
const { app } = await import('./app.ts')
const { db, purgeExpired } = await import('./db.ts')

// one sequential story: later tests reuse what earlier ones created
type Opts = { cookie?: string; token?: string; body?: unknown; form?: FormData; method?: string }
async function call(url: string, { cookie, token, body, form, method }: Opts = {}) {
  const headers: Record<string, string> = {}
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
    form.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'login.png', { type: 'image/png' }))
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
    form.append('file', new File(['one'], long))
    form.append('file', new File(['two'], long))
    const r = await call('/api/v1/pulls/acme/web/42', { token, form, method: 'PUT' })
    expect(r.data.files).toBe(2)
    const p = (await call(`/api/pulls/${pullId}`, { token })).data
    expect(p.files).toHaveLength(2)
    for (const f of p.files) expect((await call(f, { token })).status).toBe(200)
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
    expect((await call('/api/v1/pulls/acme/web/42', { cookie: outsider, method: 'PUT', body: { annotations: [] } })).status).toBe(404)
  })

  it('connects repositories by name', async () => {
    expect((await call(`/api/accounts/${accountId}/repositories`, { cookie: admin, body: { full_name: 'not a repo' } })).status).toBe(400)
    expect((await call(`/api/accounts/${accountId}/repositories`, { cookie: admin, body: { full_name: 'https://github.com/acme/api' } })).status).toBe(200)
    expect((await call(`/api/accounts/${accountId}/repositories`, { cookie: admin, body: { full_name: 'acme/web' } })).status).toBe(409)
    const repos = (await call(`/api/accounts/${accountId}`, { cookie: member })).data.repositories
    expect(repos.map((r: { full_name: string }) => r.full_name)).toEqual(['acme/api', 'acme/web'])
  })

  it('purges expired pull requests with their files', async () => {
    db.prepare('update pulls set expires_at = ? where id = ?').run('2000-01-01T00:00:00.000Z', pullId)
    expect(purgeExpired()).toBe(1)
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
    form.append('file', new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' }))
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
})
