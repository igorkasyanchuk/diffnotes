import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { client, png } from './testkit.ts'

// the edges app.test.ts's story doesn't walk through: limits, quotas, refusals, server errors, the static pages
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-edges-'))
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'admin-pass'
process.env.PUBLIC_URL = 'https://r42.example/'
process.env.MAX_BODY_KB = '1'
process.env.MAX_PULL_MB = '0.05'
process.env.MAX_ACCOUNT_MB = '0.01'
process.env.MAX_PULLS = '2'
process.env.BUGSINK_DSN = 'https://key@bugs.example/9'
// the web app's page comes from the build; a stand-in when the tests run before `npm run build`
// (one left behind by an interrupted run is a stand-in too, not a build: it is replaced and removed)
const index = path.resolve(import.meta.dirname, '../dist/index.html'), STAND_IN = '<link rel="canonical" href="__ORIGIN__/">'
const built = fs.existsSync(index) && fs.readFileSync(index, 'utf8') !== STAND_IN
if (!built) { fs.mkdirSync(path.dirname(index), { recursive: true }); fs.writeFileSync(index, STAND_IN) }
afterAll(() => { if (!built) fs.rmSync(index) })

const { app, recordFailure, throttle } = await import('./app.ts')
const { db, setSetting } = await import('./db.ts')
const { call, login } = client(app)

let admin = '', token = '', accountId = '', devId = '', dev = ''
const invite = async (account: string, email: string, password: string, role = 'member') => {
  const { token: inv } = (await call(`/api/accounts/${account}/invites`, { cookie: admin, body: { email, role } })).data
  const r = await call(`/api/invites/${inv}/accept`, { body: { password } })
  return { status: r.status, cookie: r.res.headers.get('set-cookie')?.split(';')[0] ?? '' }
}
const upload = (number: number, payload: unknown, files: [string, Uint8Array | string][] = []) => {
  const form = new FormData()
  form.set('payload', JSON.stringify(payload))
  for (const [name, data] of files) form.append('file', new File([data as BlobPart], name))
  return call(`/api/v1/pulls/o/n/${number}`, { token, form, method: 'PUT' })
}
const note = { path: 'a.ts', body: 'x' }

beforeAll(async () => {
  admin = await login('admin@example.com', 'admin-pass')
  accountId = (await call('/api/dashboard', { cookie: admin })).data.accounts[0].id
  token = (await call('/api/tokens', { cookie: admin, body: {} })).data.token
  dev = (await invite(accountId, 'dev@example.com', 'dev-password')).cookie
  devId = (await call('/api/me', { cookie: dev })).data.user.id
})

describe('pages', () => {
  it('serves the page, crawler files and the skill under PUBLIC_URL', async () => {
    const home = await call('/')
    expect(home.data).toContain('https://r42.example/')
    expect(home.res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(home.res.headers.get('x-robots-tag')).toBeNull()
    expect((await call('/dashboard')).res.headers.get('x-robots-tag')).toBe('noindex')
    expect((await call('/index.html')).status).toBe(200)
    expect((await call('/missing.js')).status).toBe(404)
    expect((await call('/files/nope')).status).toBe(404)
    expect((await call('/healthz')).data).toBe('ok')
    expect((await call('/robots.txt')).data).toContain('Sitemap: https://r42.example/sitemap.xml')
    expect((await call('/sitemap.xml')).data).toContain('<loc>https://r42.example/</loc>')
    expect((await call('/install.sh')).data).toContain('https://r42.example/skill/SKILL.md')
    expect((await call('/skill/SKILL.md')).data).not.toContain('{{HOST}}')
  })
})

describe('people', () => {
  it('signs out', async () => {
    const cookie = await login('dev@example.com', 'dev-password')
    expect((await call('/api/logout', { cookie, method: 'POST' })).status).toBe(200)
    expect((await call('/api/me', { cookie })).data).toEqual({ user: null })
    expect((await call('/api/logout', { method: 'POST' })).status).toBe(200)
  })

  it('changes a password, signs out other browsers and throttles guesses', async () => {
    const other = await login('dev@example.com', 'dev-password')
    expect((await call('/api/password', { cookie: dev, method: 'PUT', body: { current: 'dev-password', password: 'short' } })).status).toBe(400)
    expect((await call('/api/password', { cookie: dev, method: 'PUT', body: { current: 'dev-password', password: 'new-password' } })).status).toBe(200)
    expect((await call('/api/me', { cookie: other })).data).toEqual({ user: null })
    expect((await call('/api/me', { cookie: dev })).data.user.id).toBe(devId)
    for (let i = 0; i < 10; i++) expect((await call('/api/password', { cookie: dev, method: 'PUT', body: { current: 'wrong' } })).status).toBe(401)
    expect((await call('/api/password', { cookie: dev, method: 'PUT', body: { current: 'new-password', password: 'newer-password' } })).status).toBe(429)
  })

  it('lets an existing user accept an invitation with their password', async () => {
    const second = (await call('/api/accounts', { cookie: admin, body: { name: 'Second' } })).data.id
    expect((await invite(second, 'dev@example.com', 'new-password')).status).toBe(200)
    expect((await invite(second, 'dev@example.com', 'wrong-password')).status).toBe(401)
    expect((await call(`/api/accounts/${second}`, { cookie: dev })).data.role).toBe('member')
    expect((await call(`/api/accounts/${second}/invites`, { cookie: admin, body: { email: 'not an email' } })).status).toBe(400)
    const { token: inv } = (await call(`/api/accounts/${second}/invites`, { cookie: admin, body: { email: 'x@example.com' } })).data
    expect((await call(`/api/accounts/${second}/invites/${inv}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
    expect((await call(`/api/invites/${inv}`)).status).toBe(404)
  })

  it('guards roles: own, owner, unknown and invalid', async () => {
    const lead = await invite(accountId, 'lead@example.com', 'lead-password', 'admin')
    const owner = (await call('/api/me', { cookie: admin })).data.user.id
    const put = (cookie: string, user: string, role: string) => call(`/api/accounts/${accountId}/members/${user}`, { cookie, method: 'PUT', body: { role } })
    expect((await put(admin, devId, 'boss')).status).toBe(400)
    expect((await put(admin, owner, 'member')).status).toBe(400)
    expect((await put(admin, 'nobody', 'member')).status).toBe(404)
    expect((await put(lead.cookie, owner, 'member')).data.error).toBe('The owner keeps their role')
    const del = (cookie: string, user: string) => call(`/api/accounts/${accountId}/members/${user}`, { cookie, method: 'DELETE' })
    expect((await del(admin, owner)).status).toBe(400)
    expect((await del(lead.cookie, owner)).data.error).toBe('The owner cannot be removed')
    expect((await del(lead.cookie, devId)).status).toBe(200)
    expect((await call(`/api/accounts/${accountId}`, { cookie: dev })).status).toBe(404)
  })

  it('caps tokens at 50 and deletes one', async () => {
    for (let n = (await call('/api/tokens', { cookie: admin })).data.length; n < 50; n++) await call('/api/tokens', { cookie: admin, body: {} })
    expect((await call('/api/tokens', { cookie: admin, body: {} })).status).toBe(409)
    const last = (await call('/api/tokens', { cookie: admin })).data[0]
    expect((await call(`/api/tokens/${last.id}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
    expect((await call('/api/tokens', { cookie: admin })).data).toHaveLength(49)
  })

  it('sweeps the failure log once it is large', () => {
    vi.useFakeTimers()
    for (let i = 0; i <= 10_000; i++) recordFailure(`spray:${i}`)
    vi.setSystemTime(Date.now() + 11 * 60_000)
    const blocked = throttle('spray:0', 1, 600_000)
    vi.useRealTimers() // before the expect: a failure must not leave the rest of the file on fake time
    expect(blocked).toBe(false)
  })
})

describe('uploads', () => {
  it('accepts jpeg and webp by their signatures', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
    expect((await upload(1, { annotations: [note] }, [['a.jpg', jpeg], ['b.webp', webp]])).status).toBe(200)
    expect((await upload(1, { annotations: [] }, [['a.jpg', webp]])).status).toBe(415)
  })

  it('refuses bad payloads and anything over the limits', async () => {
    const form = new FormData()
    form.set('payload', '{nope')
    expect((await call('/api/v1/pulls/o/n/1', { token, form, method: 'PUT' })).data.error).toBe('payload is not JSON')
    expect((await upload(1, { annotations: Array.from({ length: 501 }, () => note) })).status).toBe(413)
    expect((await upload(1, { annotations: [] }, Array.from({ length: 31 }, (_, i) => [`${i}.png`, png()] as [string, Uint8Array]))).status).toBe(413)
    // over MAX_BODY_KB as JSON, over MAX_PULL_MB as any body
    const big = { annotations: [{ path: 'a', body: 'x'.repeat(2000) }] }
    expect((await call('/api/v1/pulls/o/n/1', { token, method: 'PUT', body: big, headers: { 'content-length': String(JSON.stringify(big).length) } })).status).toBe(413)
    expect((await upload(1, { annotations: [] }, [['big.png', png(60_000)]])).data.error).toBe('Too large')
  })

  it('keeps each account within its quotas', async () => {
    expect((await upload(1, { annotations: [] }, [['big.png', png(11_000)]])).status).toBe(413)
    expect((await upload(2, { annotations: [note] })).status).toBe(200)
    expect((await upload(3, { annotations: [note] })).data.error).toMatch(/2 pull requests with notes/)
    expect((await upload(2, { annotations: [note, note] })).status).toBe(200)
  })

  it('answers 404 for what is not there', async () => {
    const pull = (await call('/api/v1/pulls/o/n/1', { token })).data
    expect((await call(`/files/${pull.id}/missing.png`, { cookie: admin })).status).toBe(404)
    expect((await call('/api/pulls/nope', { cookie: admin })).status).toBe(404)
    expect((await call('/api/repositories/nope', { cookie: admin, method: 'DELETE' })).status).toBe(404)
  })
})

describe('server errors', () => {
  it('reports a crash with the route pattern only and rolls a failed upload back', async () => {
    const fetch = vi.fn(async () => new Response()), log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetch)
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('insert into annotations')) throw new Error('disk on fire')
      return prepare(sql)
    })
    const r = await upload(1, { title: 'changed', annotations: [{ path: 'b.ts', body: 'y' }] })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    expect(r).toMatchObject({ status: 500, data: { error: 'Server error' } })
    expect(log).toHaveBeenCalled()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://bugs.example/api/9/envelope/')
    expect(init.body).toContain('"transaction":"PUT /api/v1/pulls/:repo{.+}/:number{[0-9]+}"')
    expect(init.body).not.toContain('o/n/1')
    expect((await call('/api/v1/pulls/o/n/1', { token })).data.annotations.map((a: { path: string }) => a.path)).toEqual(['a.ts'])
  })
})

describe('super admin', () => {
  it('refuses unknown users and bad storage settings', async () => {
    expect((await call('/api/admin/users/nope', { cookie: admin, method: 'PUT', body: { admin: true } })).status).toBe(404)
    const put = (body: Record<string, unknown>) => call('/api/admin/storage', { cookie: admin, method: 'PUT', body: { kind: 's3', ...body } })
    const s3 = { endpoint: 'http://127.0.0.1:1', bucket: 'bucket', key_id: 'k', secret: 's' }
    expect((await put({ ...s3, endpoint: 'ftp://x' })).data.error).toMatch(/^Endpoint/)
    expect((await put({ ...s3, bucket: 'B' })).data.error).toMatch(/^Bucket name/)
    expect((await put({ ...s3, prefix: '../x' })).data.error).toMatch(/^Prefix/)
    expect((await put({ ...s3, secret: '' })).data.error).toMatch(/required/)
    expect((await put(s3)).data.error).toMatch(/^Couldn't write to the bucket: /)
    expect((await call('/api/admin/storage/lifecycle', { cookie: admin, method: 'POST' })).data.error).toBe('S3 storage is not configured')
    // files still in the current bucket pin it
    setSetting('storage', { kind: 'disk', endpoint: 'http://127.0.0.1:1', bucket: 'old', prefix: '', region: 'auto', key_id: 'k' })
    const pull = (await call('/api/v1/pulls/o/n/1', { token })).data.id
    db.prepare(`insert into files (pull_id, name, type, size, backend) values (?, 'x.png', 'image/png', 1, 's3')`).run(pull)
    expect((await put(s3)).status).toBe(409)
  })
})
