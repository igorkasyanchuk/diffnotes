import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import '../extension/markdown.js'
import { client, mp4, png, webm } from './testkit.ts'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-'))
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'admin-pass'
const { app } = await import('./app.ts')
const { db } = await import('./db.ts')
const { fromCloudflare, purge, repoName } = await import('./app.ts')
const { call, login, mcp } = client(app)

// one sequential story: later tests reuse what earlier ones created
let admin = '', token = '', accountId = '', member = '', pullId = ''

describe('diffnotes', () => {
  beforeAll(async () => { admin = await login('admin@example.com', 'admin-pass') })

  it('rejects a wrong password and anonymous API calls', async () => {
    expect((await call('/api/login', { body: { email: 'admin@example.com', password: 'nope' } })).status).toBe(401)
    expect((await call('/api/dashboard')).status).toBe(401)
    expect((await call('/api/me')).data).toMatchObject({ user: null })
  })

  it('bootstraps the first admin with an account', async () => {
    const d = (await call('/api/dashboard', { cookie: admin })).data
    expect(d.accounts).toHaveLength(1)
    expect(d.accounts[0].role).toBe('owner')
    expect(d.retention_days).toBe(365)
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
    expect(token).toMatch(/^dn_/)
    const list = (await call('/api/tokens', { cookie: admin })).data
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(token)
    expect((await call('/api/v1/me', { token })).data.user.email).toBe('admin@example.com')
    const me = (await call('/api/me', { cookie: admin })).data
    expect(me).toMatchObject({ accounts: [{ role: 'owner' }] })
    expect((await call('/api/v1/me', { token: 'dn_wrong' })).status).toBe(401)
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
    expect(p.authors).toEqual([{ name: 'Admin', avatar: null }]) // the uploader, by name; no GitHub sign-in: no photo
    // the dashboard: a page of PRs with who uploaded them; a page past the end is the last one
    const d = (await call('/api/dashboard?page=99', { cookie: member })).data
    expect(d).toMatchObject({ total: 1, page: 1, per_page: 20, pulls: [{ id: pullId, uploader: 'Admin' }] })
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

  it('removes single notes and keeps risk levels', async () => {
    const put = await call('/api/v1/pulls/acme/web/78', { token, method: 'PUT', body: { annotations: [
      { path: 'a.ts', body: 'keep', risk: 'high' }, { path: 'b.ts', line: 3, body: 'stale', risk: 'nonsense' }] } })
    const [keep, stale] = (await call('/api/v1/pulls/acme/web/78', { token })).data.annotations
    expect([keep.risk, stale.risk]).toEqual(['high', null])
    expect((await call(`/api/v1/annotations/${stale.id}`, { cookie: member, method: 'DELETE' })).status).toBe(403)
    expect((await call(`/api/v1/annotations/${stale.id}`, { token, method: 'DELETE' })).status).toBe(200)
    expect((await call(`/api/v1/annotations/${stale.id}`, { token, method: 'DELETE' })).status).toBe(404)
    expect((await call('/api/v1/pulls/acme/web/78', { token })).data.annotations.map((a: { body: string }) => a.body)).toEqual(['keep'])
    // every note has its author: a member's upload replaces only their own, teammates' notes and the summary stay
    await call('/api/v1/pulls/acme/web/78', { token, method: 'PUT', body: { summary: 'by admin', annotations: [{ path: 'a.ts', body: 'keep' }] } })
    const body = { annotations: [{ path: 'a.ts', body: 'mine' }] }
    expect((await call('/api/v1/pulls/acme/web/78', { cookie: member, method: 'PUT', body })).status).toBe(200)
    expect((await call('/api/v1/pulls/acme/web/78', { cookie: member, method: 'PUT', body })).status).toBe(200)
    const both = (await call('/api/v1/pulls/acme/web/78', { cookie: member })).data
    expect(both).toMatchObject({ summary: 'by admin', can_delete: true, can_delete_all: false })
    expect(both.authors).toHaveLength(2) // the member (last uploader) first, then the admin
    expect(both.authors[1].name).toBe('Admin')
    // the admin's summary kept by the member's blank upload: the PR's fields have no single author now (the demo checks it)
    expect(db.prepare('select fields_by from pulls where id = ?').get(put.data.id)).toEqual({ fields_by: null })
    expect(both.annotations.map((a: { body: string; can_delete: boolean }) => [a.body, a.can_delete])).toEqual([['keep', false], ['mine', true]])
    expect((await call(`/api/v1/annotations/${both.annotations[0].id}`, { cookie: member, method: 'DELETE' })).status).toBe(403)
    expect((await call(`/api/v1/annotations/${both.annotations[1].id}`, { cookie: member, method: 'DELETE' })).status).toBe(200)
    // nothing of theirs left: "remove" is an admin's only
    expect((await call(`/api/pulls/${put.data.id}`, { cookie: member, method: 'DELETE' })).data.error).toMatch(/you have none/)
    // "remove all" of an author takes their own notes; the PR goes with the last of them
    await call('/api/v1/pulls/acme/web/78', { cookie: member, method: 'PUT', body })
    expect((await call(`/api/pulls/${put.data.id}`, { cookie: member, method: 'DELETE' })).status).toBe(200)
    expect((await call('/api/v1/pulls/acme/web/78', { token })).data.annotations.map((a: { body: string }) => a.body)).toEqual(['keep'])
    // the member uploaded last but wrote nothing left: only who wrote the notes is listed
    expect((await call('/api/v1/pulls/acme/web/78', { token })).data.authors).toEqual([{ name: 'Admin', avatar: null }])
    const solo = new FormData()
    solo.set('payload', JSON.stringify({ annotations: [{ path: 'a.ts', body: '![s](attachment:solo.png)' }] }))
    solo.append('file', new File([png()], 'solo.png'))
    const alone = await call('/api/v1/pulls/acme/web/79', { cookie: member, form: solo, method: 'PUT' })
    expect((await call(`/api/pulls/${alone.data.id}`, { cookie: member, method: 'DELETE' })).status).toBe(200)
    expect((await call(`/api/pulls/${alone.data.id}`, { cookie: admin })).status).toBe(404)
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'uploads', alone.data.id, 'solo.png'))).toBe(false) // its bytes too
    // a PR uploaded with a summary only (no notes, no files) is its uploader's to remove
    const bare = await call('/api/v1/pulls/acme/web/80', { cookie: member, method: 'PUT', body: { summary: 'only this', annotations: [] } })
    expect((await call(`/api/pulls/${bare.data.id}`, { cookie: member })).data).toMatchObject({ can_delete: true, authors: [{ name: expect.any(String), avatar: null }] }) // its uploader
    expect((await call(`/api/pulls/${bare.data.id}`, { cookie: member, method: 'DELETE' })).status).toBe(200)
    expect((await call(`/api/pulls/${bare.data.id}`, { cookie: admin })).status).toBe(404)
    // files too: a teammate's upload keeps the other's, even under the same name
    const shot = (cookie: string, text: string) => {
      const form = new FormData()
      form.set('payload', JSON.stringify({ annotations: [{ path: 'a.ts', body: `${text} ![s](attachment:shot.png)` }] }))
      form.append('file', new File([png(16 + text.length)], 'shot.png'))
      return call('/api/v1/pulls/acme/web/78', { cookie, form, method: 'PUT' })
    }
    await shot(admin, 'admin'); await shot(member, 'member'); await shot(member, 'member again')
    const files = (await call('/api/v1/pulls/acme/web/78', { token })).data
    expect(files.files.map((f: { mine: boolean }) => f.mine).sort()).toEqual([false, true]) // the token is the admin's
    for (const a of files.annotations) {
      const url = a.body.match(/\/files\/[^)]+/)[0]
      expect((await call(url, { cookie: admin })).data.length).toBe(16 + a.body.split(' !')[0].length)
    }
    expect((await call(`/api/pulls/${put.data.id}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
  })

  it('deletes a pull request\'s notes by id, for members of its account only', async () => {
    const put = await call('/api/v1/pulls/acme/web/77', { token, method: 'PUT', body: { annotations: [{ path: 'a.ts', body: 'stale' }] } })
    expect(put.status).toBe(200)
    const other = (await call('/api/accounts', { cookie: admin, body: { name: 'Elsewhere' } })).data
    const { token: t } = (await call(`/api/accounts/${other.id}/invites`, { cookie: admin, body: { email: 'else@example.com' } })).data
    const stranger = (await call(`/api/invites/${t}/accept`, { body: { password: 'stranger-pass' } })).res.headers.get('set-cookie')!.split(';')[0]
    expect((await call(`/api/pulls/${put.data.id}`, { cookie: stranger, method: 'DELETE' })).status).toBe(404)
    // an uploader who has left the account is outside it like anyone else
    const [note] = (await call('/api/v1/pulls/acme/web/77', { token })).data.annotations
    const strangerId = (await call('/api/me', { cookie: stranger })).data.user.id
    db.prepare('update pulls set user_id = ? where id = ?').run(strangerId, put.data.id)
    db.prepare('update annotations set user_id = ? where id = ?').run(strangerId, note.id) // the note's author, too
    expect((await call(`/api/v1/annotations/${note.id}`, { cookie: stranger, method: 'DELETE' })).status).toBe(404)
    // a member who didn't upload them reads but can't remove; the uploader (or an admin) can
    expect((await call(`/api/pulls/${put.data.id}`, { cookie: member })).data.can_delete).toBe(false)
    expect((await call(`/api/pulls/${put.data.id}`, { cookie: member, method: 'DELETE' })).status).toBe(403)
    expect((await call('/api/v1/pulls/acme/web/77', { token })).data.can_delete).toBe(true)
    expect((await call('/api/v1/pulls/acme/web/77?id=not-this-one', { token, method: 'DELETE' })).status).toBe(409)
    expect((await call(`/api/v1/pulls/acme/web/77?id=${put.data.id}`, { token, method: 'DELETE' })).status).toBe(200)
    expect((await call('/api/v1/pulls/acme/web/77', { token })).status).toBe(404)
    expect((await call(`/api/accounts/${other.id}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
    db.prepare('delete from users where email = ?').run('else@example.com')
  })

  it('knows Cloudflare addresses (CLOUDFLARE_ONLY lets only those connect)', () => {
    expect(fromCloudflare('104.16.1.1')).toBe(true)
    expect(fromCloudflare('2606:4700::1')).toBe(true)
    expect(fromCloudflare('8.8.8.8')).toBe(false)
    expect(fromCloudflare('not an ip')).toBe(false)
  })

  it('throttles logins by the client a local proxy or Cloudflare names, never by a header from anyone else', async () => {
    // a second failure within a second from the same client and email answers 429
    const attempt = async (remoteAddress: string, headers: Record<string, string>) => (await app.request('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email: 'ip@example.com', password: 'x' }),
    }, { incoming: { socket: { remoteAddress } } })).status
    expect(await attempt('172.18.0.2', { 'x-forwarded-for': '203.0.113.1' })).toBe(401)
    expect(await attempt('::ffff:172.18.0.3', { 'x-forwarded-for': '9.9.9.9, 203.0.113.1' })).toBe(429) // same client, via the proxy
    expect(await attempt('172.18.0.2', { 'x-forwarded-for': '203.0.113.2' })).toBe(401) // another client
    expect(await attempt('8.8.8.8', { 'x-forwarded-for': '203.0.113.3' })).toBe(401)
    expect(await attempt('8.8.8.8', { 'x-forwarded-for': '203.0.113.4', 'cf-connecting-ip': '203.0.113.4' })).toBe(429) // a public peer's headers don't count
    expect(await attempt('104.16.0.1', { 'cf-connecting-ip': '203.0.113.5' })).toBe(401)
    expect(await attempt('104.16.0.1', { 'cf-connecting-ip': '203.0.113.6' })).toBe(401) // Cloudflare names the client
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

  it('accepts mp4 and webm screen recordings up to 2 MB by their signatures and serves them as video', async () => {
    const up = (...files: File[]) => {
      const form = new FormData()
      form.set('payload', JSON.stringify({ annotations: [{ path: 'a.ts', body: '![Drag](attachment:drag.webm)' }] }))
      for (const f of files) form.append('file', f)
      return call('/api/v1/pulls/acme/web/44', { token, form, method: 'PUT' })
    }
    expect((await up(new File([webm(1.5 * 1024 * 1024)], 'drag.webm'), new File([mp4()], 'flow.MP4'))).status).toBe(200)
    const p = (await call('/api/v1/pulls/acme/web/44', { token })).data
    expect(p.annotations[0].body).toBe(`![Drag](/files/${p.id}/drag.webm)`)
    for (const [name, type] of [['drag.webm', 'video/webm'], ['flow.MP4', 'video/mp4']]) {
      const f = await call(`/files/${p.id}/${name}`, { token })
      expect(f.res.headers.get('content-type')).toBe(type)
      expect(f.res.headers.get('content-security-policy')).toBe('sandbox')
      expect(f.res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(f.res.headers.get('accept-ranges')).toBe('bytes')
    }
    // byte ranges, which Safari needs to play a video
    const part = await call(`/files/${p.id}/flow.MP4`, { token, headers: { range: 'bytes=4-7' } })
    expect([part.status, part.res.headers.get('content-range'), part.data]).toEqual([206, 'bytes 4-7/16', 'ftyp'])
    expect((await call(`/files/${p.id}/flow.MP4`, { token, headers: { range: 'bytes=10-' } })).res.headers.get('content-range')).toBe('bytes 10-15/16')
    expect((await call(`/files/${p.id}/flow.MP4`, { token, headers: { range: 'bytes=99-' } })).status).toBe(416)
    expect((await call(`/files/${p.id}/flow.MP4`, { token, headers: { range: 'bytes=5-2' } })).status).toBe(200) // invalid: ignored
    // If-Range: the same version gets the range, another one (re-uploaded under the same name) the whole file
    const etag = part.res.headers.get('etag')!
    expect((await call(`/files/${p.id}/flow.MP4`, { token, headers: { range: 'bytes=4-7', 'if-range': etag } })).status).toBe(206)
    expect((await call(`/files/${p.id}/flow.MP4`, { token, headers: { range: 'bytes=4-7', 'if-range': '"older"' } })).status).toBe(200)
    expect((await up(new File([png()], 'fake.webm'))).data.error).toBe('fake.webm: not a valid webm video')
    expect((await up(new File([webm()], 'fake.mp4'))).status).toBe(415)
    expect((await up(new File(['x'], 'clip.mov'))).status).toBe(415)
    expect((await up(new File([webm(2 * 1024 * 1024 + 1)], 'big.webm'))).data.error).toBe('Files up to 1MB each, videos (mp4, webm) up to 2MB')
    expect((await up(new File([png(1024 * 1024 + 1)], 'big.png'))).status).toBe(413) // the video limit is for videos only
    expect((await call('/api/v1/pulls/acme/web/44', { token, method: 'DELETE' })).status).toBe(200)
  })

  it('answers MCP clients: initialize, tools/list and the three tools, with the bearer token only', async () => {
    expect((await call('/mcp')).status).toBe(405)
    expect((await mcp('ping', {})).status).toBe(401)
    expect((await mcp('ping', {}, undefined, { cookie: admin })).status).toBe(401) // a cookie never works here
    expect((await mcp('ping', {}, undefined, { cookie: admin, authorization: 'Basic eDp5' })).status).toBe(401) // nor behind another scheme
    expect((await mcp('ping', {}, 'not-a-token')).status).toBe(401)
    expect((await mcp('ping', {}, token, { origin: 'https://evil.example' })).status).toBe(403)
    const init = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }, token)
    expect(init.data.result.protocolVersion).toBe('2025-03-26')
    expect(init.data.result.capabilities).toEqual({ tools: {} })
    expect(init.data.result.serverInfo.name).toBe('diffnotes')
    expect((await mcp('initialize', { protocolVersion: '1999-01-01' }, token)).data.result.protocolVersion).toBe('2025-06-18')
    const note = await call('/mcp', { token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    expect([note.status, note.data]).toEqual([202, ''])
    expect((await mcp('ping', undefined, token)).data).toEqual({ jsonrpc: '2.0', id: expect.any(Number), result: {} })
    const tools = (await mcp('tools/list', {}, token)).data.result.tools
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['get_notes', 'upload_notes', 'delete_notes'])
    expect(tools[1].description).toMatch(/One note per changed block[\s\S]*up to 2 MB each/)
    expect((await mcp('resources/list', {}, token)).data.error.code).toBe(-32601)
    expect((await mcp('tools/call', { name: 'nope' }, token)).data.error.code).toBe(-32602)
    expect((await mcp('tools/call', { name: 'constructor' }, token)).data.error.code).toBe(-32602)
    expect((await call('/mcp', { token, body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }] })).data.error.code).toBe(-32600)
    const garbled = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{' })
    expect([garbled.status, (await garbled.json()).error.code]).toEqual([400, -32700])
    expect((await call('/mcp', { token, body: { jsonrpc: '2.0', id: 9, method: 5 } })).data.error.code).toBe(-32600)
    expect((await call('/mcp', { token, body: { jsonrpc: '2.0', id: 9, result: {} } })).status).toBe(202) // a reply to us

    const tool = async (name: string, args: unknown) => (await mcp('tools/call', { name, arguments: args }, token)).data.result
    const target = { repo: 'https://github.com/acme/web', number: 45 }
    expect((await tool('get_notes', target)).isError).toBe(true)
    const payload = { title: 'Drag cards', head_sha: 'abc', summary: 'Cards move. ![after](attachment:after.png)',
      annotations: [{ path: 'board.ts', line: 3, body: '![Dragging](attachment:drag.webm)', risk: 'high' }] }
    const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
    const up = await tool('upload_notes', { ...target, payload, files: [{ name: 'after.png', base64: `data:image/png;base64,${b64(png())}` }, { name: 'drag.webm', base64: b64(webm()) }] })
    expect(up.isError).toBeUndefined()
    expect(up.structuredContent).toMatchObject({ annotations: 1, files: 2 })
    expect(JSON.parse(up.content[0].text).id).toBe(up.structuredContent.id)
    const got = (await tool('get_notes', target)).structuredContent
    expect(got.annotations[0].body).toBe(`![Dragging](/files/${got.id}/drag.webm)`)
    expect(got.files.map((f: { type: string }) => f.type)).toEqual(['image/png', 'video/webm'])
    expect((await call(`/files/${got.id}/drag.webm`, { token })).status).toBe(200)
    // the HTTP API's refusals come back as tool errors the model can act on, and change nothing
    expect((await tool('upload_notes', { ...target, payload, files: [{ name: 'fake.png', base64: b64(webm()) }] })).content[0].text).toBe('fake.png: not a valid png image')
    expect((await tool('upload_notes', { ...target, payload, files: [{ name: 'big.webm', base64: b64(webm(2 * 1024 * 1024 + 1)) }] })).content[0].text).toMatch(/videos \(mp4, webm\) up to 2MB/)
    expect((await tool('upload_notes', { ...target, payload, files: 'x' })).content[0].text).toBe('files must be an array')
    expect((await tool('upload_notes', { ...target, payload, files: [{ base64: '' }] })).content[0].text).toBe('files[0].name is required')
    expect((await tool('upload_notes', { ...target, payload, files: [null] })).content[0].text).toBe('files[0].name is required')
    expect((await tool('upload_notes', { ...target, payload, files: [{ name: 'a.png' }] })).content[0].text).toBe('files[0].base64 is required')
    expect((await tool('upload_notes', { ...target, payload: {} })).content[0].text).toBe('annotations must be an array')
    expect((await tool('upload_notes', { ...target, number: 0, payload })).content[0].text).toBe('Bad pull request number')
    expect((await tool('get_notes', target)).structuredContent.files).toHaveLength(2)
    // a member reads; removing is for the uploader or an admin
    const memberToken = (await call('/api/tokens', { cookie: member, body: { name: 'mcp' } })).data.token
    expect((await mcp('tools/call', { name: 'delete_notes', arguments: target }, memberToken)).data.result.isError).toBe(true)
    expect((await tool('delete_notes', target)).structuredContent).toEqual({ ok: true })
    expect((await tool('get_notes', target)).content[0].text).toBe('No annotations for this pull request')
  })

  it('takes GitLab (nested groups, self-hosted) and Bitbucket repositories as host/path', async () => {
    expect(repoName('https://gitlab.com/Acme/Platform/API.git')).toBe('gitlab.com/Acme/Platform/API')
    expect(repoName('git@bitbucket.org:team/app.git')).toBe('bitbucket.org/team/app')
    expect(repoName('https://GitLab.Acme.dev:8443/a/b/')).toBe('gitlab.acme.dev:8443/a/b')
    expect(repoName('https://github.com/rails/rails')).toBe('rails/rails')
    // a PR / MR URL (what an MCP client is likely to pass) names its repository, never a repository of its own
    expect(repoName('https://github.com/acme/web/pull/45/files')).toBe('acme/web')
    expect(repoName('https://gitlab.com/group/proj/-/merge_requests/5/diffs?view=x')).toBe('gitlab.com/group/proj')
    expect(repoName('https://bitbucket.org/team/app/pull-requests/7')).toBe('bitbucket.org/team/app')
    expect(repoName('https://gitlab.com/group/proj/-/tree/main/src')).toBe('gitlab.com/group/proj')
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
    const r = await call('http://dn.test/skill/SKILL.md')
    expect(r.data).toContain('http://dn.test')
    expect(r.data).toContain('Up to **1 MB each** (videos 2 MB),\n  30 files and 20 MB per PR')
    expect(r.data).not.toContain('{{')
    expect((await call('http://dn.test/install.sh')).data).toContain('http://dn.test/skill/SKILL.md')
  })

  it('renders Markdown without letting a later pass rewrite inside generated tags', async () => {
    const md = (globalThis as unknown as { dnMarkdown: (s: string) => string }).dnMarkdown
    expect(md('![x](/a/[y](/x/onerror=alert``//))')).not.toContain('<a href')
    expect(md('![x](http://a/[y](/x/onerror=alert``//))').match(/<a href/g)).toHaveLength(1) // the remote image's link, untouched
    expect(md('[*a](http://x/*b)')).toContain('href="http://x/*b"')
    expect(md('![s](https://t.io/p.png)')).not.toContain('<img') // remote images are links: nothing loads from a third party
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
    expect(o.recent[0]).toMatchObject({ title: 'Overview', uploader: 'Admin', annotations: 2 })
  })

  it('gives super admins server stats and every account, nobody else', async () => {
    expect((await call('/api/admin/stats', { cookie: member })).status).toBe(404)
    const st = (await call('/api/admin/stats', { cookie: admin })).data
    expect(st.totals).toMatchObject({ accounts: 2, pulls: 1, annotations: 2, upload_bytes: 10 })
    // the biggest account first; list prices for the cost estimate, files on disk here
    expect(st.accounts.map((a: { bytes: number }) => a.bytes)).toEqual([...st.accounts.map((a: { bytes: number }) => a.bytes)].sort((x, y) => y - x))
    expect(st.prices).toMatchObject({ storage: 'disk', providers: { b2: { gb_month: 0.00695, free_gb: 10 } } })
    expect(st.max_account_bytes).toBeGreaterThan(0)
    expect(st.totals.disk_free_bytes).toBeGreaterThan(0)
    expect(st.version).toMatch(/^\d+\.\d+\.\d+$/)
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

  it('stores files in the S3-compatible bucket STORAGE_TYPE names, and deletes them with the PR', async () => {
    const http = await import('node:http')
    const objects = new Map<string, Buffer>(), seen: string[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (d) => chunks.push(d)).on('end', () => {
        seen.push(`${req.method} ${req.url}`)
        if (!String(req.headers.authorization).startsWith('AWS4-HMAC-SHA256 Credential=KEY/')) { res.statusCode = 403; return res.end('unsigned') }
        if (req.method === 'PUT' && req.url!.includes('broken')) { res.statusCode = 500; return res.end() }
        if (req.method === 'PUT') objects.set(req.url!, Buffer.concat(chunks))
        if (req.method === 'DELETE') objects.delete(req.url!)
        if (req.method === 'GET' && !objects.has(req.url!)) res.statusCode = 404
        res.end(req.method === 'GET' ? objects.get(req.url!) : '')
      })
    }).listen(0)
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const env = { STORAGE_TYPE: 'minio', MINIO_ENDPOINT: endpoint, MINIO_BUCKET: 'dn-files', MINIO_ACCESS_KEY: 'KEY', MINIO_SECRET_KEY: 'SECRET', STORAGE_PREFIX: 'prod' }
    Object.assign(process.env, env)
    expect((await call('/api/admin/storage', { cookie: member })).status).toBe(404)
    const st = (await call('/api/admin/storage', { cookie: admin })).data.storage
    expect(st).toMatchObject({ kind: 's3', type: 'minio', source: 'env', bucket: 'dn-files', prefix: 'prod/', region: 'us-east-1', key_id: 'KEY' })
    expect(JSON.stringify(st)).not.toContain('SECRET')
    expect((await call('/api/admin/storage', { cookie: admin, method: 'PUT', body: { kind: 'disk' } })).status).toBe(404) // no setting it here

    const form = new FormData()
    form.set('payload', JSON.stringify({ annotations: [{ path: 'a.ts', body: '![x](attachment:s3.png)' }] }))
    form.append('file', new File([png(32)], 's3.png'))
    const up = await call('/api/v1/pulls/acme/web/44', { token, form, method: 'PUT' })
    expect(up.status).toBe(200)
    const key = `/dn-files/prod/pulls/${up.data.id}/s3.png`
    expect(objects.get(key)?.length).toBe(32)
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'uploads', up.data.id))).toBe(false)
    const img = await call(`/files/${up.data.id}/s3.png`, { token })
    expect(img.status).toBe(200)
    expect(img.res.headers.get('content-type')).toBe('image/png')
    // a write that still fails after its retries: the uploader's previous file goes anyway (no row points at it any more)
    const broken = new FormData()
    broken.set('payload', JSON.stringify({ annotations: [] }))
    broken.append('file', new File([png(32)], 'broken.png'))
    expect((await call('/api/v1/pulls/acme/web/44', { token, form: broken, method: 'PUT' })).status).toBe(500)
    expect(objects.has(key)).toBe(false)
    expect((await call('/api/v1/pulls/acme/web/44', { token, form, method: 'PUT' })).status).toBe(200)

    // a bucket set up on /admin before the environment: without STORAGE_TYPE its files still read and delete, new ones go to disk
    for (const k of Object.keys(env)) delete process.env[k]
    const { seal, setSetting } = await import('./db.ts')
    setSetting('storage', { kind: 's3', endpoint, region: 'auto', bucket: 'dn-files', key_id: 'KEY', secret: seal('SECRET'), prefix: 'prod/' })
    expect((await call('/api/admin/storage', { cookie: admin })).data.storage).toMatchObject({ kind: 'disk', source: 'settings', bucket: 'dn-files' })
    expect((await call(`/files/${up.data.id}/s3.png`, { token })).status).toBe(200)
    db.prepare('update pulls set expires_at = ? where id = ?').run('2000-01-01T00:00:00.000Z', up.data.id)
    expect(await purge()).toBe(1)
    expect(objects.has(key)).toBe(false)
    server.close()
  })
  it('lets a user delete themselves with the accounts they own, never the last super admin', async () => {
    const inv = await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { email: 'leaving@example.com', role: 'member' } })
    const joined = await call(`/api/invites/${inv.data.token}/accept`, { body: { password: 'leaving-pass' } })
    const cookie = joined.res.headers.get('set-cookie')!.split(';')[0]
    const own = (await call('/api/accounts', { cookie, body: { name: 'Leaving Co' } })).data.id
    const tok = (await call('/api/tokens', { cookie, body: { name: 'cli' } })).data.token
    const form = new FormData()
    form.set('payload', JSON.stringify({ annotations: [{ path: 'a.ts', body: 'x' }] }))
    expect((await call(`/api/accounts/${own}/repositories`, { cookie, body: { full_name: 'leaving/app' } })).status).toBe(200)
    expect((await call('/api/v1/pulls/leaving/app/1', { token: tok, form, method: 'PUT' })).status).toBe(200)
    // a token can't do it, a wrong password can't, and the only super admin can't
    expect((await call('/api/me', { token: tok, method: 'DELETE', body: { password: 'leaving-pass' } })).status).toBe(401)
    expect((await call('/api/me', { cookie, method: 'DELETE', body: { password: 'nope' } })).status).toBe(401)
    expect((await call('/api/me', { cookie: admin, method: 'DELETE', body: { password: 'admin-pass' } })).status).toBe(400)
    const gone = await call('/api/me', { cookie, method: 'DELETE', body: { password: 'leaving-pass' } })
    expect(gone.status).toBe(200)
    expect(gone.res.headers.get('set-cookie')).toContain('sid=;')
    expect((await call('/api/me', { cookie })).data.user).toBeNull()
    expect((await call('/api/v1/pulls/leaving/app/1', { token: tok })).status).toBe(401)
    expect((await call('/api/login', { body: { email: 'leaving@example.com', password: 'leaving-pass' } })).status).toBe(401)
    expect((await call(`/api/accounts/${own}`, { cookie: admin })).status).toBe(404)
    expect((await call(`/api/accounts/${accountId}`, { cookie: admin })).data.members.map((m: { email: string }) => m.email)).not.toContain('leaving@example.com')
  })
})
