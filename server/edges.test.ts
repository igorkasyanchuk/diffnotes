import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { client, png, webm } from './testkit.ts'

// the edges app.test.ts's story doesn't walk through: limits, quotas, refusals, server errors, the static pages
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-edges-'))
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'admin-pass'
process.env.PUBLIC_URL = 'https://dn.example/'
process.env.MAX_BODY_KB = '1'
process.env.MAX_PULL_MB = '0.05'
process.env.MAX_ACCOUNT_MB = '0.01'
process.env.MAX_PULLS = '2'
process.env.MAX_FILE_MB = '0.008' // 8388 bytes
process.env.MAX_VIDEO_MB = '0.012' // 12582 bytes: over the account quota, so that one still shows
process.env.MAX_FILES = '3'
process.env.MAX_ACCOUNTS = '3'
process.env.MAX_ANNOTATIONS = 'many' // not a number: the default (500), never "no limit"
process.env.BUGSINK_DSN = 'https://key@bugs.example/9'
process.env.UMAMI_SCRIPT = 'https://stats.example/script.js'
process.env.UMAMI_WEBSITE_ID = 'site-1'
// the web app's page comes from the build; a stand-in when the tests run before `npm run build`
// (one left behind by an interrupted run is a stand-in too, not a build: it is replaced and removed)
const index = path.resolve(import.meta.dirname, '../dist/index.html'), STAND_IN = '<link rel="canonical" href="__ORIGIN__/"></head>'
const built = fs.existsSync(index) && fs.readFileSync(index, 'utf8') !== STAND_IN
if (!built) { fs.mkdirSync(path.dirname(index), { recursive: true }); fs.writeFileSync(index, STAND_IN) }
afterAll(() => { if (!built) fs.rmSync(index) })

const { app, glob, recordFailure, throttle } = await import('./app.ts')
const { db, setSetting } = await import('./db.ts')
const { call, login, mcp } = client(app)

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
    expect(home.data).toContain('https://dn.example/')
    expect(home.res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(home.res.headers.get('x-robots-tag')).toBeNull()
    // analytics on the landing page only
    expect(home.data).toContain('<script defer src="https://stats.example/script.js" data-website-id="site-1" data-auto-track="false"></script>')
    expect(home.res.headers.get('content-security-policy')).toContain("script-src 'self' https://stats.example;")
    expect(home.res.headers.get('content-security-policy')).toContain("connect-src 'self' https://stats.example;")
    const dash = await call('/dashboard')
    expect(dash.res.headers.get('x-robots-tag')).toBe('noindex')
    expect(dash.data).not.toContain('stats.example')
    expect(dash.res.headers.get('content-security-policy')).not.toContain('stats.example')
    expect(dash.res.headers.get('content-security-policy')).toContain("media-src 'self';") // notes' screen recordings
    expect((await call('/index.html')).status).toBe(200)
    expect((await call('/missing.js')).status).toBe(404)
    expect((await call('/files/nope')).status).toBe(404)
    expect((await call('/.well-known/oauth-authorization-server')).status).toBe(404) // never the app's HTML
    expect((await call('/healthz')).data).toBe('ok')
    expect((await call('/robots.txt')).data).toContain('Sitemap: https://dn.example/sitemap.xml')
    expect((await call('/sitemap.xml')).data).toContain('<loc>https://dn.example/</loc>')
    expect((await call('/sitemap.xml')).data).toContain('<loc>https://dn.example/privacy</loc>')
    // the public pages name themselves: title, description, canonical; /demo only while DEMO_PR is set
    const badge = await call('/badge')
    expect(badge.data).toContain('<title>Badge · DiffNotes</title>')
    expect(badge.data).toContain('<meta property="og:title" content="Badge · DiffNotes"')
    expect(badge.data).toMatch(/<meta name="description" content="A “Reviewed with DiffNotes” badge/)
    expect(badge.data).toContain('<link rel="canonical" href="https://dn.example/badge"')
    expect(badge.res.headers.get('x-robots-tag')).toBeNull()
    expect((await call('/sitemap.xml')).data).toContain('<loc>https://dn.example/badge</loc>')
    expect((await call('/sitemap.xml')).data).not.toContain('/demo')
    expect((await call('/demo')).res.headers.get('x-robots-tag')).toBe('noindex')
    expect((await call('/demo')).data).toContain('<link rel="canonical" href="https://dn.example/"')
    const privacy = await call('/privacy')
    expect(privacy.data).toContain('<link rel="canonical" href="https://dn.example/privacy"')
    expect(privacy.status).toBe(200)
    expect(privacy.res.headers.get('x-robots-tag')).toBeNull()
    expect(privacy.data).not.toContain('stats.example')
    expect((await call('/install.sh')).data).toContain('https://dn.example/skill/SKILL.md')
    expect((await call('/skill/SKILL.md')).data).not.toContain('{{HOST}}')
    // stamped with the release, which /skill/version serves for installed copies to compare with
    const { version } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'))
    const served = (await call('/skill/version')).data as string
    expect(served).toMatch(new RegExp(`^${version.replaceAll('.', '\\.')}\\+[0-9a-f]{8}$`)) // the release + the file's hash
    expect((await call('/skill/SKILL.md')).data).toContain(`version: "${served}"`)
    expect((await call('/skill/SKILL.md')).data).not.toContain('{{VERSION}}')
  })
})

describe('people', () => {
  it('signs out', async () => {
    const cookie = await login('dev@example.com', 'dev-password')
    expect((await call('/api/logout', { cookie, method: 'POST' })).status).toBe(200)
    expect((await call('/api/me', { cookie })).data).toMatchObject({ user: null })
    expect((await call('/api/logout', { method: 'POST' })).status).toBe(200)
  })

  it('changes a password, signs out other browsers and throttles guesses', async () => {
    const other = await login('dev@example.com', 'dev-password')
    expect((await call('/api/password', { cookie: dev, method: 'PUT', body: { current: 'dev-password', password: 'short' } })).status).toBe(400)
    expect((await call('/api/password', { cookie: dev, method: 'PUT', body: { current: 'dev-password', password: 'new-password' } })).status).toBe(200)
    expect((await call('/api/me', { cookie: other })).data).toMatchObject({ user: null })
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

describe('extension sign-in (/connect)', () => {
  const chrome = 'https://fmnbgmeahjhfakpcmhimjjjplimdiibd.chromiumapp.org/'
  const firefox = `https://${createHash('sha1').update('diffnotes@diffnotes.dev').digest('hex')}.extensions.allizom.org/`
  const verifier = 'v'.repeat(50), challenge = createHash('sha256').update(verifier).digest('base64url'), state = 's'.repeat(20)
  const allow = async (redirect_uri = chrome, extra = {}) => {
    const r = await call('/api/connect', { cookie: dev, body: { redirect_uri, state, challenge, name: 'Chrome on macOS\u0007', ...extra } })
    return { ...r, code: r.status === 200 ? new URL(r.data.location).searchParams.get('code')! : '' }
  }
  const trade = (code: string, v = verifier, redirect_uri = chrome) =>
    call('/api/v1/connect/token', { body: { code, verifier: v, redirect_uri }, headers: { 'sec-fetch-site': 'cross-site' } })

  it('knows only the listed extensions, and only a signed-in browser may allow one', async () => {
    const check = (uri: string, o = {}) => call(`/api/connect?redirect_uri=${encodeURIComponent(uri)}`, o)
    expect((await check(chrome, { cookie: dev })).status).toBe(200)
    expect((await check(firefox, { cookie: dev })).status).toBe(200)
    expect((await check(`https://${'a'.repeat(32)}.chromiumapp.org/`, { cookie: dev })).status).toBe(400)
    expect((await check(`${chrome}x`, { cookie: dev })).status).toBe(400)
    expect((await check('', { cookie: dev })).data.error).toMatch(/DiffNotes popup/) // opened by hand
    expect((await check(chrome)).status).toBe(401)
    expect((await check(chrome, { token })).status).toBe(401) // tokens never reach /api/connect
    expect((await allow('https://evil.example/')).status).toBe(400)
    expect((await allow(chrome, { state: 'short' })).status).toBe(400)
    expect((await allow(chrome, { challenge: 'x' })).status).toBe(400)
  })

  it('trades a one-time code and its PKCE verifier for a token, once', async () => {
    const first = await allow()
    const back = new URL(first.data.location)
    expect(`${back.origin}${back.pathname}`).toBe(chrome)
    expect(back.searchParams.get('state')).toBe(state)
    expect(back.searchParams.get('iss')).toMatch(/^https?:\/\//)
    const proxied = await call('/api/connect', { cookie: dev, headers: { origin: 'https://dn.example' }, body: { redirect_uri: chrome, state, challenge } })
    expect(new URL(proxied.data.location).searchParams.get('iss')).toBe('https://dn.example') // the page's origin, not http:// behind a proxy
    expect((await trade(first.code, 'w'.repeat(50))).status).toBe(400) // wrong verifier: the code is gone too
    expect((await trade(first.code)).status).toBe(400)
    expect((await trade((await allow()).code, verifier, firefox)).status).toBe(400) // another redirect than allowed
    expect((await trade((await allow()).code, 'short')).status).toBe(400)
    // a code lives two minutes
    const late = (await allow()).code, t = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(t + 121_000)
    const expired = await trade(late)
    vi.restoreAllMocks() // before the expect: a failure must not leave the clock stopped for the rest of the file
    expect(expired.status).toBe(400)

    const ok = await trade((await allow()).code)
    expect(ok.status).toBe(200)
    expect(ok.data.user.email).toBe('dev@example.com')
    expect((await call('/api/v1/me', { token: ok.data.token })).data.user.email).toBe('dev@example.com')
    // named after the browser, control characters dropped, listed on Settings
    expect((await call('/api/tokens', { cookie: dev })).data.map((t: { name: string }) => t.name)).toContain('browser extension · Chrome on macOS')
    // the extension's Remove deletes its own token; a cookie has none to delete
    expect((await call('/api/v1/token', { cookie: dev, method: 'DELETE' })).status).toBe(400)
    expect((await call('/api/v1/token', { token: ok.data.token, method: 'DELETE' })).status).toBe(200)
    expect((await call('/api/v1/me', { token: ok.data.token })).status).toBe(401)
  })

  it('refuses a code for a user deleted meanwhile, and too many tokens', async () => {
    const { cookie } = await invite(accountId, 'gone@example.com', 'gone-password')
    const code = new URL((await call('/api/connect', { cookie, body: { redirect_uri: chrome, state, challenge } })).data.location).searchParams.get('code')!
    expect((await call('/api/me', { cookie, method: 'DELETE', body: { password: 'gone-password' } })).status).toBe(200)
    expect((await trade(code)).status).toBe(400)
    const many = await invite(accountId, 'many@example.com', 'many-password')
    const late = new URL((await call('/api/connect', { cookie: many.cookie, body: { redirect_uri: chrome, state, challenge } })).data.location).searchParams.get('code')!
    for (let n = 0; n < 50; n++) await call('/api/tokens', { cookie: many.cookie, body: {} })
    expect((await call('/api/connect', { cookie: many.cookie, body: { redirect_uri: chrome, state, challenge } })).status).toBe(409)
    expect((await trade(late)).status).toBe(409)
  })

  it('throttles guessed codes per address', async () => {
    for (let n = 0; n < 20; n++) await trade(`guess-${n}`)
    expect((await trade('guess')).status).toBe(429)
    // and Allow per user: the codes live in memory
    for (let n = 0; n < 20; n++) await allow()
    expect((await allow()).status).toBe(429)
  })
})

describe('setup checklist', () => {
  it('ticks the agent, the extension and the first notes as they happen', async () => {
    const { token: inv } = (await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { email: 'newbie@example.com' } })).data
    // the invitation says who sent it and for which role
    expect((await call(`/api/invites/${inv}`)).data).toMatchObject({ by: 'Admin', role: 'member', account: expect.any(String) })
    const r = await call(`/api/invites/${inv}/accept`, { body: { password: 'newbie-pass' } })
    const cookie = r.res.headers.get('set-cookie')!.split(';')[0]
    const setup = async () => (await call('/api/me', { cookie })).data.setup
    expect(await setup()).toEqual({ agent: false, extension: false, notes: false })
    const t = (await call('/api/tokens', { cookie, body: { name: 'x' } })).data.token
    await call('/api/v1/me', { token: t }) // a read without the header: an extension before 1.2, not proof of an agent
    expect(await setup()).toEqual({ agent: false, extension: false, notes: false })
    await call('/api/v1/me', { token: t, headers: { 'x-diffnotes-client': 'extension' } })
    expect(await setup()).toEqual({ agent: false, extension: true, notes: false })
    await call('/api/accounts', { cookie, body: { name: 'newbie team' } }) // an owner: the upload connects the repository
    expect((await call('/api/v1/pulls/newbie/app/1', { token: t, method: 'PUT', body: { annotations: [note] } })).status).toBe(200)
    expect(await setup()).toEqual({ agent: true, extension: true, notes: true })
    await call('/api/v1/pulls/newbie/app/1', { token: t, method: 'DELETE' }) // notes gone (or expired): the step stays done
    expect((await setup()).notes).toBe(true)
  })
})

describe('uploads', () => {
  it('accepts jpeg and webp by their signatures', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
    expect((await upload(1, { annotations: [note] }, [['a.jpg', jpeg], ['b.webp', webp]])).status).toBe(200)
    expect((await upload(1, { annotations: [] }, [['a.jpg', webp]])).status).toBe(415)
  })

  it('refuses bad payloads and anything over the limits', async () => {
    // a multipart payload is held to MAX_BODY_KB like a JSON body
    expect((await upload(1, { annotations: [{ path: 'a.ts', body: 'x'.repeat(2000) }] })).data.error).toBe('payload is over 1 KB')
    const form = new FormData()
    form.set('payload', '{nope')
    expect((await call('/api/v1/pulls/o/n/1', { token, form, method: 'PUT' })).data.error).toBe('payload is not JSON')
    expect((await upload(1, { annotations: Array.from({ length: 501 }, () => note) })).status).toBe(413)
    expect((await upload(1, { annotations: [] }, Array.from({ length: 4 }, (_, i) => [`${i}.png`, png()] as [string, Uint8Array]))).data.error).toBe('At most 3 files per pull request')
    // MAX_FILE_MB and MAX_VIDEO_MB: a video may be bigger than other files
    expect((await upload(1, { annotations: [] }, [['a.png', png(9000)]])).data.error).toBe('Files up to 0.008MB each, videos (mp4, webm) up to 0.012MB')
    expect((await upload(1, { annotations: [] }, [['a.webm', webm(13_000)]])).status).toBe(413)
    expect((await upload(1, { annotations: [note] }, [['a.webm', webm(9000)]])).status).toBe(200)
    // over MAX_BODY_KB as JSON, over MAX_PULL_MB as any body
    const big = { annotations: [{ path: 'a', body: 'x'.repeat(2000) }] }
    expect((await call('/api/v1/pulls/o/n/1', { token, method: 'PUT', body: big, headers: { 'content-length': String(JSON.stringify(big).length) } })).status).toBe(413)
    expect((await upload(1, { annotations: [] }, [['big.png', png(60_000)]])).data.error).toBe('Too large')
  })

  it('keeps each account within its quotas', async () => {
    expect((await upload(1, { annotations: [] }, [['big.webm', webm(11_000)]])).data.error).toMatch(/files are over 0.01MB/)
    expect((await upload(2, { annotations: [note] })).status).toBe(200)
    expect((await upload(3, { annotations: [note] })).data.error).toMatch(/2 pull requests with notes/)
    expect((await upload(2, { annotations: [note, note] })).status).toBe(200)
  })

  it('holds MCP uploads to the same limits', async () => {
    const tool = async (args: unknown) => (await mcp('tools/call', { name: 'upload_notes', arguments: { repo: 'o/n', number: 1, ...args as object } }, token)).data.result.content[0].text
    const b64 = (n: number) => Buffer.from(png(n)).toString('base64')
    expect(await tool({ payload: { annotations: [{ path: 'a', body: 'x'.repeat(2000) }] } })).toBe('payload is over 1 KB')
    expect(await tool({ payload: { annotations: [] }, files: Array.from({ length: 4 }, (_, i) => ({ name: `${i}.png`, base64: b64(16) })) })).toBe('At most 3 files per pull request')
    expect(await tool({ payload: { annotations: [] }, files: [{ name: 'a.png', base64: b64(9000) }] })).toMatch(/^Files up to 0.008MB/)
    // the request itself: MAX_PULL_MB of files as base64 plus MAX_BODY_KB
    const huge = await mcp('tools/call', { name: 'upload_notes', arguments: { repo: 'o/n', number: 1, payload: { annotations: [] }, files: [{ name: 'a.png', base64: 'A'.repeat(80_000) }] } }, token)
    expect([huge.status, huge.data.error.message]).toEqual([413, 'Too large'])
    expect((await call('/skill/SKILL.md')).data).toContain('Up to **0.008 MB each** (videos 0.012 MB),\n  3 files and 0.05 MB per PR')
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
  it('refuses unknown users, and deletes another user with the accounts it owns', async () => {
    expect((await call('/api/admin/users/nope', { cookie: admin, method: 'PUT', body: { admin: true } })).status).toBe(404)
    const { createAccount, createUser } = await import('./db.ts')
    const adminId = (await call('/api/me', { cookie: admin })).data.user.id
    const squat = createUser('squat@example.com', 'squat-pass'), own = createAccount('Squat team', squat)
    expect((await call(`/api/admin/users/${adminId}`, { cookie: admin, method: 'DELETE' })).status).toBe(400) // yourself: Settings
    expect((await call('/api/admin/users/nope', { cookie: admin, method: 'DELETE' })).status).toBe(404)
    expect((await call(`/api/admin/users/${squat}`, { cookie: dev, method: 'DELETE' })).status).toBe(404) // super admins only
    await call(`/api/admin/users/${squat}`, { cookie: admin, method: 'PUT', body: { admin: true } })
    expect((await call(`/api/admin/users/${squat}`, { cookie: admin, method: 'DELETE' })).data.error).toMatch(/super admin flag first/)
    await call(`/api/admin/users/${squat}`, { cookie: admin, method: 'PUT', body: { admin: false } })
    expect((await call(`/api/admin/users/${squat}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
    expect(db.prepare('select 1 from users where id = ?').get(squat)).toBeUndefined()
    expect(db.prepare('select 1 from accounts where id = ?').get(own)).toBeUndefined()
  })

  it('manages an account it is not in and sees its counts, never its notes or files', async () => {
    const own = (await call('/api/accounts', { cookie: dev, body: { name: 'Dev team' } })).data.id
    await call(`/api/accounts/${own}/repositories`, { cookie: dev, body: { full_name: 'dev/app' } })
    const devToken = (await call('/api/tokens', { cookie: dev, body: {} })).data.token
    const form = new FormData()
    form.set('payload', JSON.stringify({ annotations: [{ path: 'a.ts', body: 'secret' }] }))
    form.append('file', new File([png() as BlobPart], 'shot.png'))
    const pull = (await call('/api/v1/pulls/dev/app/1', { token: devToken, form, method: 'PUT' })).data.id
    expect((await call(`/files/${pull}/shot.png`, { token: devToken })).status).toBe(200)
    expect((await call('/api/v1/pulls/dev/app/1', { token })).status).toBe(404)
    expect((await call(`/api/pulls/${pull}`, { cookie: admin })).status).toBe(404)
    expect((await call(`/files/${pull}/shot.png`, { cookie: admin })).status).toBe(404)
    const view = (await call(`/api/accounts/${own}/overview`, { cookie: admin })).data
    expect(view.totals).toMatchObject({ pulls: 1, annotations: 1, files: 1 })
    expect(view.recent).toEqual([]) // no titles or uploaders
    // no way in through an invitation: none to see, none to make
    await call(`/api/accounts/${own}/invites`, { cookie: dev, body: { email: 'x@example.com' } })
    expect((await call(`/api/accounts/${own}`, { cookie: admin })).data.invites).toEqual([])
    expect((await call(`/api/accounts/${own}/invites`, { cookie: admin, body: { email: 'admin@example.com' } })).status).toBe(403)
    // a user owns MAX_ACCOUNTS accounts at most; a nearly full disk takes no more files
    for (const name of ['Second', 'Third']) expect((await call('/api/accounts', { cookie: dev, body: { name } })).status).toBe(200)
    expect((await call('/api/accounts', { cookie: dev, body: { name: 'Fourth' } })).data.error).toMatch(/^You own 3 accounts/)
    const full = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 10, bsize: 4096 } as fs.StatsFs)
    try {
      const again = new FormData()
      again.set('payload', JSON.stringify({ annotations: [] }))
      again.append('file', new File([png() as BlobPart], 'shot.png'))
      expect((await call('/api/v1/pulls/dev/app/1', { token: devToken, form: again, method: 'PUT' })).status).toBe(507)
      // notes alone too: they go into the database on the same volume; an empty upload only removes yours, so it passes
      expect((await call('/api/v1/pulls/dev/app/1', { token: devToken, method: 'PUT', body: { annotations: [{ path: 'a.ts', body: 'x' }] } })).status).toBe(507)
      expect((await call('/api/v1/pulls/dev/app/1', { token: devToken, method: 'PUT', body: { annotations: [] } })).status).toBe(200)
    } finally { full.mockRestore() }
    expect((await call(`/api/pulls/${pull}`, { cookie: admin, method: 'DELETE' })).status).toBe(200)
  })
})

describe('repository rules and the deploy card', () => {
  it('matches path globs', () => {
    expect(glob('web/**').test('web/a/b.tsx')).toBe(true)
    expect(glob('**/*.css').test('styles.css')).toBe(true)
    expect(glob('**/*.css').test('web/x/styles.css')).toBe(true)
    expect(glob('*.css').test('web/styles.css')).toBe(false)
    expect(glob('a?.md').test('ab.md')).toBe(true)
    expect(glob('a.(b)+').test('a.(b)+')).toBe(true) // regex characters are literal
    expect(glob('a/**/b').test('a/b')).toBe(true)
    expect(glob('a/**/b').test('a/x/y/b')).toBe(true)
    expect(glob('a?').test('a/')).toBe(false)
    // a pattern that would backtrack for ages as a regex answers at once
    const t = Date.now()
    expect(glob('*a'.repeat(100) + 'b').test('a'.repeat(500))).toBe(false)
    expect(Date.now() - t).toBeLessThan(1000)
  })

  it('refuses an upload that misses what its repository requires, and stores the deploy card', async () => {
    const acc = (await call('/api/accounts', { cookie: admin, body: { name: 'Ruled' } })).data.id
    const repo = (await call(`/api/accounts/${acc}/repositories`, { cookie: admin, body: { full_name: 'ruled/app' } })).data.id
    const put = (payload: unknown, files: [string, Uint8Array][] = []) => {
      const form = new FormData()
      form.set('payload', JSON.stringify(payload))
      for (const [name, data] of files) form.append('file', new File([data as BlobPart], name))
      return call('/api/v1/pulls/ruled/app/1', { token, form, method: 'PUT' })
    }
    expect((await call(`/api/repositories/${repo}/rules`, { cookie: dev, method: 'PUT', body: { risk: true } })).status).toBe(404)
    expect((await call(`/api/repositories/nope/rules`, { cookie: admin, method: 'PUT', body: { risk: true } })).status).toBe(404)
    // gitignore habits: a leading / goes, a folder means everything in it
    expect((await call(`/api/repositories/${repo}/rules`, { cookie: admin, method: 'PUT', body: { screenshots: '/api/ docs/' } })).data).toEqual({ screenshots: 'api/**, docs/**' })
    const set = await call(`/api/repositories/${repo}/rules`, { cookie: admin, method: 'PUT', body: { risk: true, deploy: true, screenshots: ' web/** ,, *.css ', extra: 1 } })
    expect(set.data).toEqual({ risk: true, deploy: true, screenshots: 'web/**, *.css' })
    expect((await call(`/api/repositories/${repo}/rules`, { cookie: admin, method: 'PUT', body: { screenshots: 'a/'.repeat(151) } })).status).toBe(400)
    expect((await call(`/api/accounts/${acc}`, { cookie: admin })).data.repositories[0].rules).toEqual(set.data)

    const bad = await put({ annotations: [{ path: 'web/a.tsx', body: 'x' }] })
    expect(bad.status).toBe(422)
    expect(bad.data.error).toContain('a risk (low, medium or high) on every note')
    expect(bad.data.error).toContain('a deploy card')
    expect(bad.data.error).toContain('web/a.tsx matches web/**, *.css')
    expect((await call('/api/v1/pulls/ruled/app/1', { token })).status).toBe(404) // nothing stored
    expect((await put({ deploy: '  \n ', annotations: [{ path: 'api/a.ts', body: 'x', risk: 'low' }] })).data.error).toContain('a deploy card') // blank is none
    expect((await put({ deploy: 'x', annotations: [null] })).status).toBe(400) // not a note: no path
    // a note off the globs needs no screenshot; on them, an image or video does it
    expect((await put({ deploy: 'nothing special', annotations: [{ path: 'api/a.ts', body: 'x', risk: 'low' }] })).status).toBe(200)
    const ok = await put({ deploy: 'Run `migrate`, then flip **express**.', annotations: [{ path: 'web/a.tsx', body: 'x', risk: 'high' }] }, [['shot.png', png()]])
    expect(ok.status).toBe(200)
    expect((await call('/api/v1/pulls/ruled/app/1', { token })).data.deploy).toBe('Run `migrate`, then flip **express**.')
    // a teammate's empty upload (removing only their notes) keeps that card, and the kept card meets the rule
    const mate = await invite(acc, 'mate@example.com', 'mate-password')
    expect((await call('/api/v1/pulls/ruled/app/1', { cookie: mate.cookie, method: 'PUT', body: { annotations: [] } })).status).toBe(200)
    const mcpBad = await mcp('tools/call', { name: 'upload_notes', arguments: { repo: 'ruled/app', number: 1, payload: { annotations: [{ path: 'a', body: 'x' }] } } }, token)
    expect(JSON.stringify(mcpBad.data)).toContain('rules ask for')

    expect((await call(`/api/repositories/${repo}/rules`, { cookie: admin, method: 'PUT', body: {} })).data).toEqual({})
    expect((await put({ annotations: [{ path: 'web/a.tsx', body: 'x' }] })).status).toBe(200)
  })

  it('stores the preview deploy, each note\'s path on it and the stack, and marks the stacked PRs with notes', async () => {
    // in the account above (MAX_ACCOUNTS is reached), its pull request gone (MAX_PULLS)
    const acc = (await call('/api/dashboard', { cookie: admin })).data.accounts.find((a: { name: string }) => a.name === 'Ruled').id
    expect((await call('/api/v1/pulls/ruled/app/1', { token, method: 'DELETE' })).status).toBe(200)
    expect((await call(`/api/accounts/${acc}/repositories`, { cookie: admin, body: { full_name: 'stack/app' } })).status).toBe(200)
    const put = (n: number, body: unknown) => call(`/api/v1/pulls/stack/app/${n}`, { token, method: 'PUT', body })
    const get = async (n: number) => (await call(`/api/v1/pulls/stack/app/${n}`, { token })).data
    const first = await put(41, { preview: 'https://pr-41.example.dev', stack: [{ number: 41, title: 'fee table' }, { number: 42, title: 'picker' }],
      annotations: [{ path: 'a.ts', body: 'x', try: '/checkout?step=2' }, { path: 'a.ts', line: 3, body: 'y', code: '  if (total  <= 0)\n return ' }, { path: 'a.ts', body: 'z', code: 'no line' }] })
    expect(first.status).toBe(200)
    expect((await put(42, { preview: 'http://pr-42.example.dev', stack: [{ number: 41 }, { number: 42, title: 'picker' }, { number: 43 }, { number: 41 }, 'x', { number: -1 }],
      annotations: [{ path: 'a.ts', body: 'x', try: '//evil.example' }, { path: 'b.ts', body: 'x', try: 'javascript:alert(1)' }, { path: 'c.ts', body: 'x', try: '/a b' }] })).status).toBe(200)
    const one = await get(41), two = await get(42)
    expect(one.preview).toBe('https://pr-41.example.dev/')
    expect(one.annotations[0].try).toBe('/checkout?step=2')
    expect(one.annotations.map((a: { code: unknown }) => a.code)).toEqual([null, 'if (total <= 0) return', null]) // whitespace collapsed, only with a line
    expect(two.preview).toBe('') // https only
    expect(two.annotations.map((a: { try: unknown }) => a.try)).toEqual([null, null, null]) // a path here, never another host
    expect(two.stack).toEqual([{ number: 41, title: '', notes: true }, { number: 42, title: 'picker', notes: true }, { number: 43, title: '', notes: false }])
    // a stack without this PR, or with it alone, is none
    expect((await put(41, { stack: [{ number: 7 }, { number: 8 }], annotations: [note] })).status).toBe(200)
    expect((await get(41)).stack).toEqual([])
    expect((await put(41, { stack: [{ number: 41 }], annotations: [note] })).status).toBe(200)
    expect((await get(41)).stack).toEqual([])
    // its notes cleared (an empty upload leaves the row): no longer marked
    expect((await put(41, { annotations: [] })).status).toBe(200)
    expect((await get(42)).stack[0]).toEqual({ number: 41, title: '', notes: false })
  })
})

describe('GitHub sign-in', () => {
  type Email = { email: string; primary: boolean; verified: boolean }
  const start = async (next = '') => {
    const r = await call(`/auth/github${next}`)
    return { status: r.status, loc: new URL(r.res.headers.get('location') ?? 'x:'), cookie: r.res.headers.get('set-cookie')?.split(';')[0] ?? '' }
  }
  // the whole round trip: our redirect, then GitHub sending the browser back, with GitHub's API answered by the stubs
  const roundTrip = async (profile: object, emails: Email[], { next = '', token = 'gho_x', state = '', session = '' } = {}) => {
    const s = await start(next)
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const url = String(u)
      if (url === 'https://github.com/login/oauth/access_token') return Response.json(token ? { access_token: token } : { error: 'bad_verification_code' })
      return Response.json(url.endsWith('/user') ? profile : emails)
    })
    try {
      const r = await call(`/auth/github/callback?code=c1&state=${state || s.loc.searchParams.get('state')}`, { headers: { cookie: [s.cookie, session].filter(Boolean).join('; ') } })
      const set = r.res.headers.get('set-cookie') ?? ''
      return { to: r.res.headers.get('location') ?? '', cookie: set.match(/sid=[^;]+/)?.[0] ?? '', link: set.match(/ghlink=[^;]+/)?.[0] ?? '' }
    } finally { spy.mockRestore() }
  }
  const mail = (email: string, primary = true, verified = true) => ({ email, primary, verified })

  it('is off without an OAuth app', async () => {
    expect((await start()).status).toBe(404)
    expect((await call('/auth/github/callback?code=x&state=y')).status).toBe(404)
    expect((await call('/api/me')).data).toEqual({ user: null, github: false, signup: false, demo: null })
    expect((await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { github: 'octo' } })).data.error).toContain('GitHub sign-in is off')
  })

  it('signs up, links by email, joins invitations, refuses strangers', async () => {
    process.env.GITHUB_CLIENT_ID = 'cid'
    process.env.GITHUB_CLIENT_SECRET = 'csecret'
    try {
      const s = await start('?next=//evil.example')
      expect(s.status).toBe(302)
      expect(s.loc.origin + s.loc.pathname).toBe('https://github.com/login/oauth/authorize')
      expect(s.loc.searchParams.get('redirect_uri')).toBe('https://dn.example/auth/github/callback')
      expect((await call('/api/me')).data).toMatchObject({ user: null, github: true, signup: false })

      const octo = { id: 7, login: 'octo', name: null }
      expect((await roundTrip(octo, [mail('octo@example.com')], { state: 'forged' })).to).toContain('expired')
      expect((await roundTrip(octo, [mail('octo@example.com')])).to).toContain('ask%20a%20teammate') // sign-up is closed
      expect((await roundTrip(octo, [mail('octo@example.com', true, false)])).to).toContain('verified%20email')
      expect((await roundTrip(octo, [mail('octo@example.com')], { token: '' })).to).toContain('refused')
      const down = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
      const d = await start()
      expect((await call(`/auth/github/callback?code=c&state=${d.loc.searchParams.get('state')}`, { headers: { cookie: d.cookie } })).res.headers.get('location')).toContain('did%20not%20answer')
      down.mockRestore()

      // an existing user found by a verified (here: secondary) email. Whoever accepted its invitation may not own the
      // address, so a user with a password links GitHub only after signing in with that password once
      const boss = await invite(accountId, 'boss@example.com', 'boss-password')
      const gh = [mail('boss@gh.example'), mail('boss@example.com', false)]
      const a = await roundTrip({ id: 8, login: 'boss' }, gh, { next: '?next=/%09/evil.example' })
      expect([a.to, a.cookie]).toEqual([`/login?error=${encodeURIComponent('Sign in with your DiffNotes password once: then this GitHub account is linked to it')}`, ''])
      // the wrong password links nothing; a link meant for another user isn't taken either
      expect((await call('/api/login', { body: { email: 'boss@example.com', password: 'nope-nope' }, headers: { cookie: a.link } })).status).toBe(401)
      expect((await call('/api/login', { body: { email: 'admin@example.com', password: 'admin-pass' }, headers: { cookie: a.link } })).status).toBe(200)
      expect((await roundTrip({ id: 8 }, gh)).cookie).toBe('')
      // the password proves it: linked, nothing dropped (password, tokens, accounts)
      const bossToken = (await call('/api/tokens', { cookie: boss.cookie, body: {} })).data.token
      await new Promise((r) => setTimeout(r, 1100)) // the login throttle: one wrong password per second per email
      // and the sign-in goes on where it was headed (/\t/evil.example is //evil.example to a browser: the dashboard)
      expect((await call('/api/login', { body: { email: 'boss@example.com', password: 'boss-password' }, headers: { cookie: a.link } })).data).toEqual({ ok: true, next: '/dashboard' })
      const b = await roundTrip({ id: 8 }, [mail('renamed@gh.example')], { next: '?next=/settings' })
      expect(b.to).toBe('/settings')
      expect((await call('/api/me', { cookie: b.cookie })).data).toMatchObject({ user: { email: 'boss@example.com' }, has_password: true, accounts: [{ id: accountId }] })
      expect((await call('/api/v1/me', { token: bossToken })).status).toBe(200)
      expect((await roundTrip({ id: 8 }, [mail('renamed@gh.example')], { next: '?next=/.//evil.example' })).to).toBe('/dashboard') // dot segments: //evil.example
      // signed in already as that user: linked right away
      const chief = await invite(accountId, 'chief@example.com', 'chief-password')
      expect((await roundTrip({ id: 11, login: 'chief' }, [mail('chief@example.com')], { session: chief.cookie })).cookie).not.toBe('')
      // linked: another GitHub account with the same email (moved to it on GitHub) doesn't get in
      expect((await roundTrip({ id: 80 }, [mail('boss@example.com')])).to).toContain('another%20GitHub%20account')

      // an invitation for one of the GitHub emails: the user is made without an account, then joins without a password
      const { token: inv } = (await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { email: 'joiner@example.com' } })).data
      const j = await roundTrip({ id: 9, login: 'joiner' }, [mail('joiner@example.com')], { next: `?next=/invite/${inv}` })
      expect(j.to).toBe(`/invite/${inv}`)
      expect((await call(`/api/invites/${inv}`, { cookie: j.cookie })).data).toMatchObject({ exists: true, signed_in: true })
      expect((await call(`/api/invites/${inv}/accept`, { cookie: j.cookie, body: {} })).status).toBe(200)
      expect((await call('/api/me', { cookie: j.cookie })).data.accounts.map((x: { id: string }) => x.id)).toEqual([accountId])

      // an invitation by GitHub login: it waits for that login's sign-in (which may make the user), then joins from the dashboard
      expect((await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { github: 'bad login' } })).status).toBe(400)
      const { token: byLogin } = (await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { github: '@Hubber' } })).data
      expect((await call(`/api/accounts/${accountId}`, { cookie: admin })).data.invites[0]).toMatchObject({ email: '', github: 'hubber' })
      // the link alone joins nobody: not with a password, not as another user
      expect((await call(`/api/invites/${byLogin}/accept`, { body: { password: 'whatever-123' } })).status).toBe(403)
      expect((await call(`/api/invites/${byLogin}/accept`, { cookie: j.cookie, body: {} })).status).toBe(403)
      expect((await call(`/api/invites/${byLogin}`)).data).toMatchObject({ github: 'hubber', exists: false, signed_in: false })
      const h = await roundTrip({ id: 12, login: 'HUBBER' }, [mail('hub@example.com')]) // sign-up is closed: the invitation lets them in
      expect(h.to).toBe('/dashboard') // invited, not a member yet: the invitation to join is there
      expect((await call('/api/dashboard', { cookie: h.cookie })).data).toMatchObject({ accounts: [], invites: [{ token: byLogin, role: 'member' }] })
      expect((await call(`/api/invites/${byLogin}`, { cookie: h.cookie })).data).toMatchObject({ exists: true, signed_in: true })
      expect((await call(`/api/invites/${byLogin}/accept`, { cookie: h.cookie, body: {} })).status).toBe(200)
      expect((await call('/api/dashboard', { cookie: h.cookie })).data).toMatchObject({ accounts: [{ id: accountId }], invites: [] })

      // an open link: anyone joins until it expires (signed in, a new user, or an existing one with its password) and it stays
      expect((await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { open: true, minutes: 7 } })).status).toBe(400)
      const { token: openLink } = (await call(`/api/accounts/${accountId}/invites`, { cookie: admin, body: { open: true, minutes: 5 } })).data
      expect((await call(`/api/invites/${openLink}`)).data).toMatchObject({ open: true, signed_in: false })
      expect((await call(`/api/invites/${openLink}/accept`, { body: { email: 'nope', password: 'x' } })).status).toBe(400)
      expect((await call(`/api/invites/${openLink}/accept`, { body: { email: 'walkin@example.com', password: 'short' } })).status).toBe(400)
      // GitHub sign-in is on: a typed email makes no user (that would squat it), and says so like a wrong password
      expect((await call(`/api/invites/${openLink}/accept`, { body: { email: 'walkin@example.com', password: 'walkin-pass', name: 'Walk' } })).data.error).toContain('continue with GitHub')
      expect((await call(`/api/invites/${openLink}/accept`, { body: { email: 'boss@example.com', password: 'boss-password' } })).status).toBe(200)
      expect((await call(`/api/invites/${openLink}/accept`, { body: { email: 'boss@example.com', password: 'wrong-pass' } })).status).toBe(401)
      // without GitHub sign-in the form makes new users
      delete process.env.GITHUB_CLIENT_ID
      expect((await call(`/api/invites/${openLink}/accept`, { body: { email: 'walkin2@example.com', password: 'walkin-pass', name: 'Walk' } })).status).toBe(200)
      process.env.GITHUB_CLIENT_ID = 'cid'
      // a short password says the same for an email with a user and one without: no telling which emails exist
      expect((await call(`/api/invites/${openLink}/accept`, { body: { email: 'walkin@example.com', password: 'short' } })).status).toBe(400)
      expect((await call(`/api/invites/${openLink}/accept`, { body: { email: 'boss@example.com', password: 'short' } })).status).toBe(400)
      const other = (await call('/api/accounts', { cookie: h.cookie, body: { name: 'other team' } })).data.id
      const { token: otherLink } = (await call(`/api/accounts/${other}/invites`, { cookie: h.cookie, body: { open: true, minutes: 1440 } })).data
      expect((await call(`/api/invites/${otherLink}/accept`, { cookie: j.cookie, body: {} })).status).toBe(200) // signed in: joins as is
      expect((await call('/api/me', { cookie: j.cookie })).data.accounts.map((x: { id: string }) => x.id)).toContain(other)
      expect((await call(`/api/accounts/${accountId}`, { cookie: admin })).data.invites.some((i: { token: string; open: number }) => i.token === openLink && i.open)).toBe(true)
      // a GitHub sign-in headed to an open link gets a user even with sign-up closed
      expect((await roundTrip({ id: 13, login: 'walker' }, [mail('walker@example.com')], { next: `?next=/invite/${openLink}` })).to).toBe(`/invite/${openLink}`)
      db.prepare('update invites set expires_at = ? where token = ?').run('2000-01-01T00:00:00.000Z', openLink)
      expect((await call(`/api/invites/${openLink}`)).status).toBe(404)

      // open sign-up: a new user with a team account of their own, no password until they set one
      process.env.ALLOW_SIGNUP = '1'
      const n = await roundTrip(octo, [mail('octo@example.com')])
      expect(n.to).toBe('/welcome')
      const me = (await call('/api/me', { cookie: n.cookie })).data
      expect(me).toMatchObject({ has_password: false, github: true, signup: true, accounts: [{ name: 'octo team', role: 'owner' }] })
      expect(me.user.name).toBe('octo')
      expect((await call('/api/login', { body: { email: 'octo@example.com', password: '' } })).status).toBe(401)
      expect((await call('/api/password', { cookie: n.cookie, method: 'PUT', body: { password: 'octo-pass-1' } })).status).toBe(200)
      expect((await call('/api/me', { cookie: n.cookie })).data.has_password).toBe(true)
    } finally {
      delete process.env.GITHUB_CLIENT_ID; delete process.env.GITHUB_CLIENT_SECRET; delete process.env.ALLOW_SIGNUP
    }
  })

  it('deletes a password-less user on the session alone', async () => {
    process.env.GITHUB_CLIENT_ID = 'cid'; process.env.GITHUB_CLIENT_SECRET = 'csecret'; process.env.ALLOW_SIGNUP = '1'
    try {
      const n = await roundTrip({ id: 10, login: 'gone' }, [mail('gone@example.com')])
      expect((await call('/api/me', { cookie: n.cookie, method: 'DELETE', body: {} })).status).toBe(200)
      expect(db.prepare('select 1 from users where email = ?').get('gone@example.com')).toBeUndefined()
    } finally {
      delete process.env.GITHUB_CLIENT_ID; delete process.env.GITHUB_CLIENT_SECRET; delete process.env.ALLOW_SIGNUP
    }
  })
})

describe('GitHub photos', () => {
  it('serves the photo of a GitHub user you share an account with, through this server', async () => {
    const { createAccount, createUser } = await import('./db.ts')
    const me = (await call('/api/me', { cookie: admin })).data.user.id
    const loner = createUser('loner@example.com', 'loner-pass')
    createAccount('Alone', loner)
    db.prepare('update users set github_id = ? where id = ?').run('90583231', me)
    db.prepare('update users set github_id = ? where id = ?').run('90000009', loner)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(png, { headers: { 'content-type': 'image/png' } }))
    try {
      const r = await call(`/api/users/${me}/avatar`, { cookie: admin })
      expect(r.status).toBe(200)
      expect(r.res.headers.get('content-type')).toBe('image/png')
      expect(fetch).toHaveBeenCalledWith('https://avatars.githubusercontent.com/u/90583231?s=64&v=4', expect.anything())
      await call(`/api/users/${me}/avatar`, { cookie: admin })
      expect(fetch).toHaveBeenCalledTimes(1) // kept for a day
      expect((await call(`/api/users/${loner}/avatar`, { cookie: admin })).status).toBe(404) // no account in common
      expect((await call(`/api/users/${devId}/avatar`, { cookie: admin })).status).toBe(404) // no GitHub sign-in
      expect((await call(`/api/users/${me}/avatar`)).status).toBe(401)
      // the members list and the dashboard point at it
      expect((await call(`/api/accounts/${accountId}`, { cookie: admin })).data.members.find((m: { id: string }) => m.id === me).avatar).toBe(`/api/users/${me}/avatar`)
      // GitHub answering something else than a photo, or not at all: 404, the page shows initials
      db.prepare('update users set github_id = ? where id = ?').run('90000042', me)
      fetch.mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html' } }))
      expect((await call(`/api/users/${me}/avatar`, { cookie: admin })).status).toBe(404)
      fetch.mockRejectedValueOnce(new Error('offline'))
      expect((await call(`/api/users/${me}/avatar`, { cookie: admin })).status).toBe(404)
      fetch.mockResolvedValueOnce(new Response(new Uint8Array(300 * 1024), { headers: { 'content-type': 'image/png' } }))
      expect((await call(`/api/users/${me}/avatar`, { cookie: admin })).status).toBe(404)
    } finally {
      fetch.mockRestore()
      db.prepare('update users set github_id = null where id in (?, ?)').run(me, loner)
    }
  })
})

describe('live demo (DEMO_PR)', () => {
  it('lets every signed-in user read the demo PR and its files, which never expire', async () => {
    const { createAccount, createUser, now } = await import('./db.ts')
    const { purge } = await import('./app.ts')
    const adminId = (await call('/api/me', { cookie: admin })).data.user.id
    // the super admin's demo, written straight to the database (this file's tiny quotas are used up by now)
    const acc = createAccount('Demo', adminId), past = '2000-01-01T00:00:00.000Z'
    db.prepare('insert into repositories (id, account_id, full_name, created_at) values (?, ?, ?, ?)').run('demo-repo', acc, 'acme/demo', now())
    db.prepare(`insert into pulls (id, repository_id, number, title, user_id, created_at, updated_at, expires_at, fields_by)
      values ('demo-pull', 'demo-repo', 5, 'Demo', ?, ?, ?, ?, ?)`).run(adminId, now(), now(), past, adminId)
    db.prepare(`insert into annotations (pull_id, path, body, user_id) values ('demo-pull', 'a.ts', 'why', ?)`).run(adminId)
    db.prepare(`insert into files (pull_id, name, type, size, user_id) values ('demo-pull', 'shot.png', 'image/png', 16, ?)`).run(adminId)
    fs.mkdirSync(path.join(process.env.DATA_DIR!, 'uploads', 'demo-pull'), { recursive: true })
    fs.writeFileSync(path.join(process.env.DATA_DIR!, 'uploads', 'demo-pull', 'shot.png'), png())
    // a stranger: a user of their own account only
    const stranger = createUser('stranger@example.com', 'stranger-pass')
    createAccount('Elsewhere', stranger)
    const cookie = await login('stranger@example.com', 'stranger-pass')
    const tok = (await call('/api/tokens', { cookie, body: {} })).data.token

    expect((await call('/api/v1/pulls/acme/demo/5', { token: tok })).status).toBe(404) // off
    process.env.DEMO_PR = 'https://github.com/acme/demo#5'
    try {
      const r = await call('/api/v1/pulls/acme/demo/5', { token: tok })
      expect(r.status).toBe(200)
      expect(r.data).toMatchObject({ annotations: [{ body: 'why' }], can_delete: false, authors: [] }) // who wrote it: members only
      expect((await call('/sitemap.xml')).data).toContain('<loc>https://dn.example/demo</loc>')
      const demoPage = await call('/demo')
      expect(demoPage.res.headers.get('x-robots-tag')).toBeNull()
      expect(demoPage.data).toContain('<title>Live demo · DiffNotes</title>')
      expect((await call(r.data.files[0].url, { token: tok })).status).toBe(200)
      expect((await call('/api/v1/pulls/acme/demo/6', { token: tok })).status).toBe(404) // only that PR
      expect((await call('/api/v1/pulls/acme/demo/5', { token: tok, method: 'DELETE' })).status).toBe(404) // read only
      expect((await call('/api/me', { cookie })).data.demo).toEqual({ repository: 'acme/demo', number: 5 })
      process.env.DEMO_PR = 'https://github.com/acme/demo/pull/5' // the URL works too
      expect((await call('/api/me', { cookie })).data.demo).toEqual({ repository: 'acme/demo', number: 5 })
      await purge()
      expect(db.prepare("select 1 from pulls where id = 'demo-pull'").get()).toBeTruthy() // expired, kept
      // hidden for now (a teammate's field kept), still not deleted for good
      db.prepare("update pulls set fields_by = null where id = 'demo-pull'").run()
      await purge()
      expect(db.prepare("select 1 from pulls where id = 'demo-pull'").get()).toBeTruthy()
      db.prepare("update pulls set fields_by = ? where id = 'demo-pull'").run(adminId)
      // only what super admins wrote is the demo: a teammate's last upload (its summary, title) keeps it private
      db.prepare("update pulls set user_id = ? where id = 'demo-pull'").run(stranger)
      expect((await call('/api/me', { cookie })).data.demo).toBeNull()
      db.prepare("update pulls set user_id = ? where id = 'demo-pull'").run(adminId)
      // and a title, summary or deploy card a super admin's blank upload kept from a teammate (fields_by null)
      db.prepare("update pulls set fields_by = null where id = 'demo-pull'").run()
      expect((await call('/api/me', { cookie })).data.demo).toBeNull()
      db.prepare("update pulls set fields_by = ? where id = 'demo-pull'").run(adminId)
      // and so does one note by anyone else
      db.prepare(`insert into annotations (pull_id, path, body, user_id) values ('demo-pull', 'b.ts', 'private', ?)`).run(stranger)
      expect((await call('/api/me', { cookie })).data.demo).toBeNull()
      expect((await call('/api/v1/pulls/acme/demo/5', { token: tok })).status).toBe(404)
    } finally { delete process.env.DEMO_PR }
    await purge()
    expect(db.prepare("select 1 from pulls where id = 'demo-pull'").get()).toBeUndefined()
  })
})
