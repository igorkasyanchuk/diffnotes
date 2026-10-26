import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { BlockList, isIP } from 'node:net'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { getConnInfo } from '@hono/node-server/conninfo'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import {
  DATA_DIR, DB_FILE, EXT_TYPES, RETENTION_DAYS, UPLOADS, bootstrap, createAccount, createUser, daysFromNow, db, getSetting, hashPassword, newToken, now, purgeExpired,
  seal, sessionSecret, setSetting, sha256, unseal, verifyPassword,
} from './db.ts'
import { applyLifecycle, checkS3, storage } from './storage.ts'
import type { S3Config } from './storage.ts'
import type { User } from './db.ts'

const SECRET = process.env.SESSION_SECRET || sessionSecret()
const MB = 1024 * 1024
// a limit from the environment: unset, empty or not a number is the default (NaN would switch the limit off, '' make it 0)
const limit = (name: string, fallback: number) => { const n = Number(process.env[name] || fallback); return n >= 0 ? n : fallback }
const MAX_FILE = limit('MAX_FILE_MB', 1) * MB
const MAX_VIDEO = limit('MAX_VIDEO_MB', 2) * MB // .mp4 / .webm screen recordings
const MAX_PULL = limit('MAX_PULL_MB', 20) * MB
const MAX_FILES = limit('MAX_FILES', 30) // per pull request
const MAX_BODY = limit('MAX_BODY_KB', 1024) * 1024
const MAX_ANNOTATIONS = limit('MAX_ANNOTATIONS', 500) // per pull request
const RISKS = ['low', 'medium', 'high'] // an annotation's optional risk: where reviewers should look hardest
const MAX_ACCOUNT = limit('MAX_ACCOUNT_MB', 1024) * MB // files of all of an account's pull requests
const MAX_PULLS = limit('MAX_PULLS', 1000) // live pull requests per account
const INVITE_DAYS = 7
const ROOT = path.resolve(import.meta.dirname, '..')
// without PUBLIC_URL the Host header decides, and it lands in install.sh (shell) and HTML: only a plain host[:port] passes
const host = (c: Context) => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '')
  const origin = new URL(c.req.url).origin
  return /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) ? origin : 'http://localhost'
}
const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const DIST = path.relative(process.cwd(), path.join(ROOT, 'dist'))
const DUMMY_HASH = hashPassword(randomUUID())

bootstrap(process.env.ADMIN_EMAIL ?? 'admin', process.env.ADMIN_PASSWORD ?? '')

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
const fail = (status: number, message: string): never => { throw new HttpError(status, message) }

type Env = { Variables: { user: User } }
export const app = new Hono<Env>()

app.use(secureHeaders({ referrerPolicy: 'no-referrer' }))
// CLOUDFLARE_ONLY=1: only Cloudflare's edge may connect, so the server's own address serves nothing and Cloudflare
// can't be skipped. /healthz stays open to local peers (the container healthcheck).
const CLOUDFLARE_ONLY = process.env.CLOUDFLARE_ONLY === '1'
const ranges = (list: string) => {
  const b = new BlockList(), family = (ip: string): 'ipv4' | 'ipv6' => (isIP(ip) === 6 ? 'ipv6' : 'ipv4')
  for (const r of list.split(' ')) { const [ip, bits] = r.split('/'); b.addSubnet(ip, Number(bits), family(ip)) }
  return (ip: string) => isIP(ip) > 0 && b.check(ip, family(ip))
}
// ponytail: Cloudflare's ranges as published at cloudflare.com/ips; a range they add answers 403 until it's added here
export const fromCloudflare = ranges('173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 ' +
  '108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 ' +
  '104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 ' +
  '2a06:98c0::/29 2c0f:f248::/32')
// loopback, private, shared (100.64/10: Tailscale, some platforms' edges) and link-local networks: where a proxy in
// front of us (Traefik, nginx, Caddy, a platform's router) or the healthcheck connects from
const isLocal = ranges('127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 ::1/128 fc00::/7 fe80::/10')
// The peer: the socket, or the last X-Forwarded-For entry when the socket is a local proxy (the entry it appended;
// earlier ones, and the header from anyone else, are whatever the client sent).
// ponytail: a proxy on a public address isn't trusted; a TRUST_PROXY setting if one shows up
const peerIp = (c: Context) => {
  let socket = ''
  try { socket = getConnInfo(c).remote.address ?? '' } catch {}
  const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
  return (forwarded && isLocal(socket) ? forwarded : socket).replace(/^::ffff:(?=\d+\.)/, '')
}
if (CLOUDFLARE_ONLY) app.use('*', async (c, next) => {
  const ip = peerIp(c)
  if (!fromCloudflare(ip) && !(c.req.path === '/healthz' && isLocal(ip))) return c.text('Forbidden', 403)
  await next()
})

// Cookie-signed-in writes must come from this site's own pages. SameSite=Lax lets sibling subdomains through, so ask
// the browser (Sec-Fetch-Site); curl, the skill and the extension send Bearer tokens instead and aren't affected.
app.use('/api/*', async (c, next) => {
  const site = c.req.header('sec-fetch-site')
  if (c.req.method !== 'GET' && !c.req.header('authorization') && site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'Cross-site request refused' }, 403)
  await next()
})
app.use('/api/*', bodyLimit({ maxSize: MAX_PULL, onError: (c) => c.json({ error: 'Too large' }, 413) }))
// Optional error tracking: a Sentry envelope to any Sentry-compatible DSN (Bugsink, GlitchTip, Sentry).
// Only the route pattern is sent, never the path or body.
// ponytail: plain fetch, no SDK; no breadcrumbs or source context, add @sentry/node if those matter
export function report(err: Error, route: string, method: string) {
  const dsn = URL.parse(process.env.BUGSINK_DSN ?? '')
  if (!dsn) return
  const frames = (err.stack ?? '').split('\n').slice(1).reverse().map((l) => {
    const m = l.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/)
    return m ? { function: m[1] ?? '?', filename: m[2], lineno: +m[3], colno: +m[4] } : { function: l.trim() }
  })
  const event_id = randomUUID().replaceAll('-', '')
  const event = {
    event_id, timestamp: Date.now() / 1000, platform: 'node', level: 'error',
    transaction: `${method} ${route}`, request: { method, url: route },
    exception: { values: [{ type: err.name, value: err.message, stacktrace: { frames } }] },
  }
  fetch(`${dsn.origin}/api${dsn.pathname}/envelope/`, {
    method: 'POST',
    headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.username}` },
    body: [{ event_id }, { type: 'event' }, event].map((x) => JSON.stringify(x)).join('\n'),
  }).catch(() => {})
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400)
  console.error(err)
  report(err, c.req.routePath, c.req.method)
  return c.json({ error: 'Server error' }, 500)
})

const json = async (c: Context) => {
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY) fail(413, 'Too large')
  return ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
}
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// --- auth: session cookie (web app) or Bearer token (skill, extension)

const USER_COLS = 'u.id, u.email, u.name, u.admin'
async function currentUser(c: Context): Promise<User | undefined> {
  const bearer = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1]
  if (bearer) {
    // tokens are for the skill, MCP clients and the extension: annotations and files only, never tokens, passwords or /admin
    if (!/^\/(api\/v1\/|files\/|mcp$)/.test(c.req.path)) return
    const user = db.prepare(`select ${USER_COLS}, t.id as token_id from tokens t join users u on u.id = t.user_id where t.hash = ?`)
      .get(sha256(bearer)) as (User & { token_id: string }) | undefined
    if (!user) return
    db.prepare('update tokens set last_used_at = ? where id = ?').run(now(), user.token_id)
    return { id: user.id, email: user.email, name: user.name, admin: user.admin }
  }
  const sid = await getSignedCookie(c, SECRET, 'sid')
  if (!sid) return
  return db.prepare(`select ${USER_COLS} from sessions s join users u on u.id = s.user_id where s.id = ? and s.created_at > ?`)
    .get(sid, new Date(Date.now() - 30 * 86400_000).toISOString()) as User | undefined
}
const auth = async (c: Context<Env>, next: () => Promise<void>) => {
  const user = await currentUser(c)
  if (!user) return c.json({ error: 'Sign in first' }, 401)
  c.set('user', user)
  await next()
}

async function startSession(c: Context, userId: string) {
  const id = randomBytes(24).toString('base64url')
  db.prepare('insert into sessions (id, user_id, created_at) values (?, ?, ?)').run(id, userId, now())
  await setSignedCookie(c, 'sid', id, SECRET, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400, secure: (process.env.PUBLIC_URL ?? '').startsWith('https://'),
  })
}

// ponytail: in-memory, per process; 1 failure per second per IP+email, 20 per email per 10 minutes.
// Stale keys are swept once the map passes 10k entries, so sprayed emails can't grow it forever.
const failures = new Map<string, number[]>()
export function throttle(key: string, limit: number, windowMs: number) {
  const t = Date.now()
  if (failures.size > 10_000) for (const [k, l] of failures) if (!l.length || t - l[l.length - 1] > 600_000) failures.delete(k)
  const list = (failures.get(key) ?? []).filter((x) => t - x < windowMs)
  failures.set(key, list)
  return list.length >= limit
}
// re-reads the key: a sweep in a later throttle() call may have dropped an entry that was still empty
export const recordFailure = (key: string) => failures.set(key, [...(failures.get(key) ?? []), Date.now()])
// Per IP + email is the tight budget. Per IP stops one client spraying emails; per email (loose) stops many IPs guessing
// one password, and is high enough that a stranger can't lock a known user out without a lot of addresses.
const loginKeys = (c: Context, email: string) => { const ip = clientIp(c); return [`ie:${ip}:${email}`, `i:${ip}`, `e:${email}`] }
const throttled = ([ie, i, e]: string[]) => throttle(ie, 10, 600_000) || throttle(`${ie}:s`, 1, 1000) || throttle(i, 100, 600_000) || throttle(e, 50, 600_000)
const failed = (keys: string[]) => [...keys, `${keys[0]}:s`].forEach(recordFailure)
// The client: cf-connecting-ip when the peer is Cloudflare (which sets it), else the peer itself. Keyed by the peer
// behind Cloudflare, every visitor would share a few edge addresses' budgets.
const clientIp = (c: Context) => { const ip = peerIp(c); return (fromCloudflare(ip) && c.req.header('cf-connecting-ip')) || ip }

app.post('/api/login', async (c) => {
  const body = await json(c)
  const email = str(body.email).toLowerCase(), keys = loginKeys(c, email)
  if (throttled(keys)) return c.json({ error: 'Too many attempts, wait a bit' }, 429)
  const row = db.prepare('select id, password from users where email = ?').get(email) as { id: string; password: string } | undefined
  if (!verifyPassword(String(body.password ?? ''), row?.password ?? DUMMY_HASH) || !row) {
    failed(keys)
    return c.json({ error: 'Wrong email or password' }, 401)
  }
  await startSession(c, row.id)
  return c.json({ ok: true })
})

app.post('/api/logout', async (c) => {
  const sid = await getSignedCookie(c, SECRET, 'sid')
  if (sid) db.prepare('delete from sessions where id = ?').run(sid)
  deleteCookie(c, 'sid', { path: '/' })
  return c.json({ ok: true })
})

// --- GitHub sign-in: on when GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET are set (an OAuth app whose callback is
// <PUBLIC_URL>/auth/github/callback). It finds the user by GitHub id, then by any verified email of theirs. A new user is
// made with ALLOW_SIGNUP=1 (with an account of their own) or for a pending invitation (they join through it).
const github = () => (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
  ? { id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET } : null)
const signupOpen = () => !!github() && process.env.ALLOW_SIGNUP === '1'
const GH_COOKIE = { httpOnly: true, sameSite: 'Lax', path: '/auth/github', maxAge: 600, secure: (process.env.PUBLIC_URL ?? '').startsWith('https://') } as const

app.get('/auth/github', async (c) => {
  const gh = github()
  if (!gh) return c.notFound()
  const state = randomBytes(16).toString('base64url'), next = c.req.query('next') ?? ''
  // only a path on this site to come back to, never //evil.example
  await setSignedCookie(c, 'gh', JSON.stringify({ state, next: /^\/(?![/\\])/.test(next) ? next : '/dashboard' }), SECRET, GH_COOKIE)
  const q = new URLSearchParams({ client_id: gh.id, redirect_uri: `${host(c)}/auth/github/callback`, scope: 'user:email', state })
  return c.redirect(`https://github.com/login/oauth/authorize?${q}`)
})

app.get('/auth/github/callback', async (c) => {
  const gh = github()
  if (!gh) return c.notFound()
  const back = (error: string) => c.redirect(`/login?error=${encodeURIComponent(error)}`)
  const saved = JSON.parse((await getSignedCookie(c, SECRET, 'gh')) || 'null') as { state: string; next: string } | null
  deleteCookie(c, 'gh', { path: '/auth/github' })
  const code = c.req.query('code')
  if (!saved || saved.state !== c.req.query('state') || !code) return back('GitHub sign-in expired, try again')
  // ponytail: per IP, in memory like the login throttle; also caps how fast one address can make users
  const ip = `gh:${clientIp(c)}`
  if (throttle(ip, 30, 600_000)) return back('Too many attempts, wait a bit')
  recordFailure(ip)
  let profile: { id?: number; login?: string; name?: string | null }, emails: { email: string; primary: boolean; verified: boolean }[]
  try {
    const tok = await (await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: gh.id, client_secret: gh.secret, code, redirect_uri: `${host(c)}/auth/github/callback` }),
    })).json() as { access_token?: string }
    if (!tok.access_token) return back('GitHub refused the sign-in, try again')
    const get = async (p: string) => (await fetch(`https://api.github.com${p}`, { headers: {
      authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'diffnotes' } })).json()
    ;[profile, emails] = await Promise.all([get('/user'), get('/user/emails')])
  } catch { return back('GitHub did not answer, try again') }
  // the primary email first: that's the one a new user gets
  const verified = (Array.isArray(emails) ? emails : []).filter((e) => e.verified).sort((a, b) => Number(b.primary) - Number(a.primary)).map((e) => e.email)
  if (!profile?.id || !verified.length) return back('Your GitHub account needs a verified email')
  const ghId = String(profile.id), byEmail = db.prepare('select id from users where email = ?')
  let userId = (db.prepare('select id from users where github_id = ?').get(ghId) as { id: string } | undefined)?.id
    ?? verified.map((e) => (byEmail.get(e) as { id: string } | undefined)?.id).find(Boolean)
  if (!userId) {
    const invited = verified.find((e) => db.prepare('select 1 from invites where email = ? and expires_at > ?').get(e, now()))
    if (!invited && !signupOpen()) return back('No DiffNotes user for this GitHub account: ask a teammate for an invitation')
    userId = createUser(invited ?? verified[0], '', str(profile.name) || str(profile.login))
    if (!invited) createAccount(`${str(profile.login) || 'My'} team`, userId)
  }
  db.prepare('update users set github_id = ? where id = ? and github_id is null').run(ghId, userId)
  await startSession(c, userId)
  return c.redirect(saved.next)
})

const accountsOf = (userId: string) => db.prepare(`select a.id, a.name, m.role from accounts a join memberships m on m.account_id = a.id
  where m.user_id = ? order by a.created_at`).all(userId)
const tokenCount = (userId: string) => (db.prepare('select count(*) as n from tokens where user_id = ?').get(userId) as { n: number }).n

// who is signed in, plus what the app layout shows around every page: their accounts and whether they have a token yet
app.get('/api/me', async (c) => {
  const user = await currentUser(c)
  const signIn = { github: !!github(), signup: signupOpen() }
  if (!user) return c.json({ user: null, ...signIn })
  const { password } = db.prepare('select password from users where id = ?').get(user.id) as { password: string }
  return c.json({ user, accounts: accountsOf(user.id), tokens: tokenCount(user.id), has_password: !!password, ...signIn })
})

// --- invitations: the way in besides the first admin and GitHub sign-in

const inviteRow = (token: string) => db.prepare(`select i.*, a.name as account from invites i join accounts a on a.id = i.account_id
  where i.token = ? and i.expires_at > ?`).get(token, now()) as { account_id: string; email: string; role: string; account: string } | undefined

// the invitation's own user is signed in already (e.g. just came back from GitHub): joining needs no password
const signedInAs = async (c: Context, email: string) => (await currentUser(c))?.email.toLowerCase() === email.toLowerCase()

app.get('/api/invites/:token', async (c) => {
  const inv = inviteRow(c.req.param('token')) ?? fail(404, 'This invitation is invalid or expired')
  const exists = !!db.prepare('select 1 from users where email = ?').get(inv.email)
  return c.json({ email: inv.email, account: inv.account, exists, signed_in: await signedInAs(c, inv.email) })
})

app.post('/api/invites/:token/accept', async (c) => {
  const token = c.req.param('token'), body = await json(c)
  const inv = inviteRow(token) ?? fail(404, 'This invitation is invalid or expired')
  const password = String(body.password ?? '')
  let user = db.prepare('select id, password from users where email = ?').get(inv.email) as { id: string; password: string } | undefined
  if (user && await signedInAs(c, inv.email)) { /* joins as is */ } else if (user) { // same budgets as /api/login, or a shared invite link would allow unlimited password guesses
    const keys = loginKeys(c, inv.email.toLowerCase())
    if (throttled(keys)) fail(429, 'Too many attempts, wait a bit')
    if (!verifyPassword(password, user.password)) { failed(keys); fail(401, 'Wrong password') }
  } else {
    if (password.length < 8) fail(400, 'Password needs at least 8 characters')
    user = { id: createUser(inv.email, password, str(body.name, 100)), password: '' }
  }
  // an admin invite upgrades an existing member; nothing downgrades an admin or the owner
  db.prepare(`insert into memberships (account_id, user_id, role) values (?, ?, ?)
    on conflict do update set role = excluded.role where excluded.role = 'admin' and role = 'member'`).run(inv.account_id, user.id, inv.role)
  db.prepare('delete from invites where token = ?').run(token)
  await startSession(c, user.id)
  return c.json({ ok: true })
})

// --- everything below needs a signed-in user (cookie or token)

app.use('/api/*', auth)

// the signed-in user's own password (changing it, deleting yourself): 10 wrong ones in 10 minutes
function checkPassword(user: User, password: unknown, wrong: string) {
  const row = db.prepare('select password from users where id = ?').get(user.id) as { password: string }
  if (!row.password) return // signed up with GitHub and never set one: the session is the proof
  if (throttle(`pw:${user.id}`, 10, 600_000)) fail(429, 'Too many attempts, wait a bit')
  if (!verifyPassword(String(password ?? ''), row.password)) { recordFailure(`pw:${user.id}`); fail(401, wrong) }
}

// delete yourself: sessions, tokens and memberships go with the user (cascade), the accounts you own with everything in
// them; notes you uploaded to other accounts stay (their uploader becomes unknown). The password confirms it.
app.delete('/api/me', async (c) => {
  const body = await json(c), user = c.get('user')
  checkPassword(user, body.password, 'Password is wrong')
  if (user.admin && (db.prepare('select count(*) as n from users where admin = 1').get() as { n: number }).n === 1)
    fail(400, 'You are the only super admin: make another user super admin first, or nobody can run this server')
  const owned = db.prepare(`select account_id from memberships where user_id = ? and role = 'owner'`).all(user.id) as { account_id: string }[]
  const dropped = owned.map((o) => dropAccount(o.account_id))
  db.prepare('delete from users where id = ?').run(user.id)
  deleteCookie(c, 'sid', { path: '/' })
  await Promise.all(dropped)
  return c.json({ ok: true })
})

app.put('/api/password', async (c) => {
  const body = await json(c), user = c.get('user')
  checkPassword(user, body.current, 'Current password is wrong')
  const next = String(body.password ?? '')
  if (next.length < 8) fail(400, 'Password needs at least 8 characters')
  db.prepare('update users set password = ? where id = ?').run(hashPassword(next), user.id)
  // sign out every other browser; this one keeps its session (tokens are managed separately on Settings)
  db.prepare('delete from sessions where user_id = ? and id is not ?').run(user.id, (await getSignedCookie(c, SECRET, 'sid')) || null)
  return c.json({ ok: true })
})

app.get('/api/tokens', (c) => c.json(db.prepare('select id, name, created_at, last_used_at from tokens where user_id = ? order by created_at desc')
  .all(c.get('user').id)))
app.post('/api/tokens', async (c) => {
  const body = await json(c), user = c.get('user'), count = tokenCount(user.id)
  if (count >= 50) fail(409, 'Too many tokens, delete some first')
  return c.json({ token: newToken(user.id, str(body.name, 60) || `token ${count + 1}`) })
})
app.delete('/api/tokens/:id', (c) => {
  db.prepare('delete from tokens where id = ? and user_id = ?').run(c.req.param('id'), c.get('user').id)
  return c.json({ ok: true })
})

// Roles in an account: owner (made it, one per account), admin (invites, manages people and repositories), member
// (reads, uploads, removes the notes it uploaded). A super admin (users.admin) runs the server and may open and manage every account.
// Not a member and not a super admin: 404, other people's accounts don't exist for you.
const memberRole = (accountId: string, userId: string) =>
  (db.prepare('select role from memberships where account_id = ? and user_id = ?').get(accountId, userId) as { role: string } | undefined)?.role
function role(accountId: string, user: User) {
  const m = memberRole(accountId, user.id)
  if (m === 'owner' || (m && !user.admin)) return m
  // a super admin manages every account as an admin, also the ones they are only a member of
  if (user.admin && (m || db.prepare('select 1 from accounts where id = ?').get(accountId))) return 'admin'
  return fail(404, 'Not found')
}
const canManage = (r: string) => r === 'owner' || r === 'admin'
const requireAdmin = (accountId: string, user: User) => {
  const r = role(accountId, user)
  if (!canManage(r)) fail(403, 'Only account admins can do that')
  return r
}
const ROLES = ['admin', 'member']

// --- file storage: disk by default, or the S3-compatible bucket a super admin set up on /admin

type StorageSetting = Omit<S3Config, 'secret'> & { kind: 'disk' | 's3'; secret: string }
// the bucket's credentials stay usable after new uploads switch back to disk, so files already in it still read and delete
const s3Config = (): S3Config | null => {
  const st = getSetting<StorageSetting>('storage')
  return st?.secret ? { ...st, secret: unseal(st.secret) } : null
}
const store = storage(UPLOADS, s3Config, () => getSetting<StorageSetting>('storage')?.kind === 's3')

// Deletes pull requests and then their files (rows first, so a failed delete in the bucket never leaves a live PR without
// files; the bucket's lifecycle rule catches anything left over).
async function dropPulls(ids: string[]) {
  if (!ids.length) return
  const marks = ids.map(() => '?').join(',')
  const files = db.prepare(`select pull_id as pull, name, backend from files where pull_id in (${marks})`).all(...ids) as { pull: string; name: string; backend: string }[]
  db.prepare(`delete from pulls where id in (${marks})`).run(...ids)
  await store.remove(files)
}
export async function purge() {
  const ids = purgeExpired()
  await dropPulls(ids)
  return ids.length
}

app.get('/api/dashboard', (c) => {
  const user = c.get('user'), accounts = accountsOf(user.id)
  const pulls = db.prepare(`select p.id, p.number, p.title, p.updated_at, p.expires_at, r.full_name as repository,
    (select count(*) from annotations n where n.pull_id = p.id) as annotations
    from pulls p join repositories r on r.id = p.repository_id join memberships m on m.account_id = r.account_id
    where m.user_id = ? order by p.updated_at desc limit 50`).all(user.id)
  return c.json({ accounts, pulls, retention_days: RETENTION_DAYS })
})

app.post('/api/accounts', async (c) => {
  const name = str((await json(c)).name, 80) || fail(400, 'Name is required')
  return c.json({ id: createAccount(name, c.get('user').id) })
})

app.get('/api/accounts/:id', (c) => {
  const id = c.req.param('id'), user = c.get('user'), my = role(id, user)
  const account = db.prepare('select id, name from accounts where id = ?').get(id)
  const members = db.prepare(`select u.id, u.email, u.name, m.role from memberships m join users u on u.id = m.user_id
    where m.account_id = ? order by u.email`).all(id)
  const repositories = (db.prepare(`select r.id, r.full_name, r.rules, (select count(*) from pulls p where p.repository_id = r.id) as pulls
    from repositories r where r.account_id = ? order by r.full_name`).all(id) as { rules: string }[]).map((r) => ({ ...r, rules: JSON.parse(r.rules) }))
  const invites = canManage(my)
    ? db.prepare('select token, email, role, expires_at from invites where account_id = ? order by created_at desc').all(id) : []
  return c.json({ account, role: my, members, repositories, invites })
})

// what the account holds: people, repositories, annotated PRs, files and bytes on disk, latest uploads
app.get('/api/accounts/:id/overview', (c) => {
  const id = c.req.param('id')
  role(id, c.get('user'))
  const pulls = db.prepare(`select p.id, p.number, p.title, p.updated_at, p.expires_at, r.full_name as repository, u.email as uploader,
    (select count(*) from annotations n where n.pull_id = p.id) as annotations,
    (select count(*) from files f where f.pull_id = p.id) as files, (select coalesce(sum(f.size), 0) from files f where f.pull_id = p.id) as bytes
    from pulls p join repositories r on r.id = p.repository_id left join users u on u.id = p.user_id
    where r.account_id = ? order by p.updated_at desc`).all(id) as { repository: string; annotations: number; files: number; bytes: number; expires_at: string }[]
  const repos = db.prepare('select full_name from repositories where account_id = ? order by full_name').all(id) as { full_name: string }[]
  const byRepo = repos.map(({ full_name }) => {
    const ps = pulls.filter((p) => p.repository === full_name)
    return { repository: full_name, pulls: ps.length, annotations: ps.reduce((n, p) => n + p.annotations, 0),
      files: ps.reduce((n, p) => n + p.files, 0), bytes: ps.reduce((n, p) => n + p.bytes, 0) }
  })
  const count = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n
  const soon = daysFromNow(7)
  return c.json({
    totals: {
      members: count('select count(*) as n from memberships where account_id = ?'),
      admins: count(`select count(*) as n from memberships where account_id = ? and role in ('owner', 'admin')`),
      invites: count('select count(*) as n from invites where account_id = ?'),
      repositories: repos.length, pulls: pulls.length,
      annotations: byRepo.reduce((n, r) => n + r.annotations, 0), files: byRepo.reduce((n, r) => n + r.files, 0),
      bytes: byRepo.reduce((n, r) => n + r.bytes, 0), expiring_soon: pulls.filter((p) => p.expires_at < soon).length,
    },
    retention_days: RETENTION_DAYS, repositories: byRepo, recent: pulls.slice(0, 10),
  })
})

app.put('/api/accounts/:id', async (c) => {
  const id = c.req.param('id'), name = str((await json(c)).name, 80) || fail(400, 'Name is required')
  requireAdmin(id, c.get('user'))
  db.prepare('update accounts set name = ? where id = ?').run(name, id)
  return c.json({ ok: true })
})
// an account with its repositories, PRs, notes and files (cascade), memberships and invites
function dropAccount(id: string) {
  const pulls = db.prepare('select p.id from pulls p join repositories r on r.id = p.repository_id where r.account_id = ?').all(id) as { id: string }[]
  // dropPulls deletes the PR rows before its first await; the account goes in the same tick, so no upload can add a PR
  // whose files the cascade would then leave behind, and a slow bucket only delays the response, not the delete
  const dropped = dropPulls(pulls.map((p) => p.id))
  db.prepare('delete from accounts where id = ?').run(id)
  return dropped
}
app.delete('/api/accounts/:id', async (c) => {
  const id = c.req.param('id'), user = c.get('user')
  if (role(id, user) !== 'owner' && !user.admin) fail(403, 'Only the owner can delete the account')
  await dropAccount(id)
  return c.json({ ok: true })
})

app.post('/api/accounts/:id/invites', async (c) => {
  const id = c.req.param('id'), user = c.get('user'), body = await json(c)
  requireAdmin(id, user)
  const email = str(body.email).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(400, 'Enter an email address')
  const token = randomBytes(24).toString('base64url')
  db.prepare('insert into invites (token, account_id, email, role, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)')
    .run(token, id, email, body.role === 'admin' ? 'admin' : 'member', user.id, now(), daysFromNow(INVITE_DAYS))
  return c.json({ token })
})
app.delete('/api/accounts/:id/invites/:token', (c) => {
  requireAdmin(c.req.param('id'), c.get('user'))
  db.prepare('delete from invites where token = ? and account_id = ?').run(c.req.param('token'), c.req.param('id'))
  return c.json({ ok: true })
})
app.put('/api/accounts/:id/members/:user', async (c) => {
  const id = c.req.param('id'), user = c.get('user'), next = (await json(c)).role as string
  requireAdmin(id, user)
  if (!ROLES.includes(next)) fail(400, 'Role is admin or member')
  if (c.req.param('user') === user.id) fail(400, 'You cannot change your own role')
  const current = memberRole(id, c.req.param('user')) ?? fail(404, 'Not found')
  if (current === 'owner') fail(400, 'The owner keeps their role')
  db.prepare('update memberships set role = ? where account_id = ? and user_id = ?').run(next, id, c.req.param('user'))
  return c.json({ ok: true })
})
app.delete('/api/accounts/:id/members/:user', (c) => {
  const id = c.req.param('id'), user = c.get('user')
  requireAdmin(id, user)
  if (c.req.param('user') === user.id) fail(400, 'You cannot remove yourself')
  if (memberRole(id, c.req.param('user')) === 'owner') fail(400, 'The owner cannot be removed')
  db.prepare('delete from memberships where account_id = ? and user_id = ?').run(id, c.req.param('user'))
  return c.json({ ok: true })
})

// GitHub repositories are owner/name. GitLab (gitlab.com or self-hosted) and Bitbucket ones are host/path, e.g.
// gitlab.com/group/sub/project or bitbucket.org/team/app: a host has a dot and a GitHub owner can't, so they never clash.
const REPO = /^(?:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?(?:\/[A-Za-z0-9._-]{1,100}){2,20})$/
const validRepo = (n: string) => REPO.test(n) && !/(^|\/)\.+(\/|$)/.test(n)
// a pasted URL or clone address works too: https://gitlab.com/group/project.git → gitlab.com/group/project, and a PR / MR
// URL names its repository (…/pull/42/files, …/pull-requests/7; GitLab's /-/ ends the project path: …/-/merge_requests/5, …/-/tree/main)
export function repoName(s: string) {
  const [first, ...rest] = s.trim().replace(/^[a-z+]+:\/\/|^git@/i, '').replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\/-\/.*$|\/(?:pull|pull-requests)\/\d+(?:[/?#].*)?$/, '').replace(/(\.git)?\/*$/, '').split('/')
  const host = first.includes('.') ? first.toLowerCase() : first
  return (host === 'github.com' || host === 'www.github.com' ? rest : [host, ...rest]).join('/')
}
app.post('/api/accounts/:id/repositories', async (c) => {
  const id = c.req.param('id'), name = repoName(str((await json(c)).full_name))
  requireAdmin(id, c.get('user'))
  if (!validRepo(name)) fail(400, 'Use owner/name for GitHub (rails/rails), host/path for GitLab or Bitbucket (gitlab.com/group/project)')
  if (db.prepare('select 1 from repositories where account_id = ? and full_name = ?').get(id, name)) fail(409, 'This repository is already connected')
  const repo = randomUUID()
  db.prepare('insert into repositories (id, account_id, full_name, created_at) values (?, ?, ?, ?)').run(repo, id, name, now())
  return c.json({ id: repo })
})
// Rules every upload to the repository must meet (admins set them): a risk on every note, a deploy card, and a
// screenshot or recording when a note is on a path matching one of the globs (web/**, **/*.css). savePull() checks them.
app.put('/api/repositories/:id/rules', async (c) => {
  const repo = db.prepare('select account_id from repositories where id = ?').get(c.req.param('id')) as { account_id: string } | undefined
  requireAdmin(repo?.account_id ?? fail(404, 'Not found'), c.get('user'))
  const body = await json(c), paths = str(body.screenshots, 301)
  if (paths.length > 300) fail(400, 'Paths for screenshots: 300 characters at most') // cut, the last glob would silently never match
  // gitignore habits: /web/** is web/** (note paths never start with /), web/ is everything under web/
  const screenshots = paths.split(/[\s,]+/).map((g) => g.replace(/^\/+/, '').replace(/\/$/, '/**')).filter(Boolean).join(', ')
  const rules: Rules = { ...(body.risk === true && { risk: true }), ...(body.deploy === true && { deploy: true }), ...(screenshots && { screenshots }) }
  db.prepare('update repositories set rules = ? where id = ?').run(JSON.stringify(rules), c.req.param('id'))
  return c.json(rules)
})
app.delete('/api/repositories/:id', async (c) => {
  const repo = db.prepare('select id, account_id from repositories where id = ?').get(c.req.param('id')) as { id: string; account_id: string } | undefined
  if (!repo) fail(404, 'Not found')
  requireAdmin(repo!.account_id, c.get('user'))
  const pulls = db.prepare('select id from pulls where repository_id = ?').all(repo!.id) as { id: string }[]
  const dropped = dropPulls(pulls.map((p) => p.id)) // rows now, files after: see the account delete
  db.prepare('delete from repositories where id = ?').run(repo!.id)
  await dropped
  return c.json({ ok: true })
})

// --- pull request annotations (the skill writes, the extension and the web app read)

type Pull = { id: string; number: number; title: string; head_sha: string; summary: string; deploy: string; updated_at: string; expires_at: string; full_name: string; account_id: string; user_id: string | null }
const PULL_SELECT = `select p.id, p.number, p.title, p.head_sha, p.summary, p.deploy, p.updated_at, p.expires_at, r.full_name, r.account_id, p.user_id
  from pulls p join repositories r on r.id = p.repository_id`

// Removing notes is for whoever uploaded them (the PR's author, through their agent) and the account's owner and admins;
// other members read. can_delete tells the extension and the web app whether to offer it. role() first, always: an
// uploader who has left the account gets 404 like anyone else outside it.
const canRemove = (p: Pull, user: User) => canManage(role(p.account_id, user)) || p.user_id === user.id
const requireRemove = (p: Pull, user: User) => { if (!canRemove(p, user)) fail(403, 'Only the PR\'s uploader or an account admin can remove its notes') }

function pullOut(p: Pull, user: User) {
  const annotations = db.prepare('select id, path, line, end_line, side, title, body, risk from annotations where pull_id = ? order by position').all(p.id)
  const files = (db.prepare('select name, type, size from files where pull_id = ? order by name').all(p.id) as { name: string; type: string; size: number }[])
    .map((f) => ({ ...f, url: `/files/${p.id}/${encodeURIComponent(f.name)}` }))
  return {
    id: p.id, repository: p.full_name, number: p.number, title: p.title, head_sha: p.head_sha, summary: p.summary, deploy: p.deploy,
    updated_at: p.updated_at, expires_at: p.expires_at, annotations, files, can_delete: canRemove(p, user),
  }
}

// /api/v1/pulls/<repository>/<number>, where the repository is owner/name or host/path (several segments)
const PULL_PATH = '/api/v1/pulls/:repo{.+}/:number{[0-9]+}'
const findPull = (user: User, repo: string, number: number) => {
  const full = repoName(repo)
  // a name can be connected in several accounts: yours only (a super admin's own first, then any), the latest upload
  // first, the same order repositoryFor() writes in
  const mine = 'r.account_id in (select account_id from memberships where user_id = ?)'
  const p = db.prepare(`${PULL_SELECT} where r.full_name = ? and p.number = ? and (? or ${mine})
    order by ${mine} desc, p.updated_at desc limit 1`).get(full, number, user.admin, user.id, user.id) as Pull | undefined
  if (!p) fail(404, 'No annotations for this pull request')
  role(p!.account_id, user)
  return p!
}

// {repo, number}: PULL_PATH's params or an MCP tool's arguments
const pullOf = (user: User, a: Record<string, unknown>) => findPull(user, String(a.repo ?? ''), Number(a.number))

app.get('/api/v1/me', (c) => c.json({ user: c.get('user') }))
app.get(PULL_PATH, (c) => c.json(pullOut(pullOf(c.get('user'), c.req.param()), c.get('user'))))
const pullById = (c: Context<Env>, id = c.req.param('id') ?? '') => {
  const p = db.prepare(`${PULL_SELECT} where p.id = ?`).get(id) as Pull | undefined
  if (!p) fail(404, 'Not found')
  role(p!.account_id, c.get('user'))
  return p!
}
app.get('/api/pulls/:id', (c) => c.json(pullOut(pullById(c), c.get('user'))))
const removeAll = async (user: User, p: Pull) => {
  requireRemove(p, user)
  await dropPulls([p.id])
  return { ok: true }
}
// "delete notes" (web app): by id, so it's always the PR on the page even when its name is connected in several accounts
app.delete('/api/pulls/:id', async (c) => c.json(await removeAll(c.get('user'), pullById(c))))
// one note, from the extension's "remove" on GitHub, GitLab or Bitbucket; the PR and its files stay
app.delete('/api/v1/annotations/:id{[0-9]+}', (c) => {
  const id = Number(c.req.param('id'))
  const a = db.prepare('select pull_id from annotations where id = ?').get(id) as { pull_id: string } | undefined
  requireRemove(pullById(c, a?.pull_id ?? ''), c.get('user'))
  db.prepare('delete from annotations where id = ?').run(id)
  return c.json({ ok: true })
})
// ?id=<pull id>: the extension's "remove all notes" names the exact PR it showed (the name can be in several accounts)
app.delete(PULL_PATH, async (c) => {
  const p = pullOf(c.get('user'), c.req.param())
  if (c.req.query('id') && c.req.query('id') !== p.id) fail(409, 'These notes changed since the page loaded: reload it')
  return c.json(await removeAll(c.get('user'), p))
})

// cut from the front, so a long name keeps the extension fileType() checked (else `….html.png` would be stored as `….html`)
const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100).replace(/^\.+/, '') || 'file'

// Uploads are checked by content, not only by name: images and videos must start with their format's signature, text files must be
// UTF-8 without NUL bytes (html too: it only ever runs as a sandboxed demo). SVG, PDF, archives and anything else are refused.
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'video/mp4': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'video/webm': (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
}
const utf8 = new TextDecoder('utf-8', { fatal: true })
export function fileType(name: string, data: Buffer) {
  const type = EXT_TYPES[path.extname(name).slice(1).toLowerCase()]
  if (!type) fail(415, `${name}: only png, jpg, gif, webp, mp4, webm, csv, md, txt and html files are accepted`)
  if (MAGIC[type]) {
    if (!MAGIC[type](data)) fail(415, `${name}: not a valid ${type.split('/')[1]} ${type.split('/')[0]}`)
  } else {
    try { utf8.decode(data) } catch { fail(415, `${name}: text files must be UTF-8`) }
    if (data.includes(0)) fail(415, `${name}: text files can't contain NUL bytes`)
  }
  return type
}

// The repository connected in one of your accounts: the one with this PR's latest upload (what findPull() reads), else
// one you manage. Not connected anywhere you are: an owner or admin gets it connected to their first such account
// (`id` is null until the upload passes its checks); a member asks an admin to connect it.
function repositoryFor(fullName: string, number: number, user: User): { id: string | null; account_id: string } {
  if (!validRepo(fullName)) fail(400, 'Bad repository name: owner/name for GitHub, host/path for GitLab or Bitbucket')
  const repo = db.prepare(`select r.id, r.account_id from repositories r join memberships m on m.account_id = r.account_id and m.user_id = ?
    where r.full_name = ? order by (select p.updated_at from pulls p where p.repository_id = r.id and p.number = ?) desc nulls last,
    m.role in ('owner', 'admin') desc limit 1`).get(user.id, fullName, number) as { id: string; account_id: string } | undefined
  if (repo) return repo
  const acc = db.prepare(`select account_id from memberships where user_id = ? and role in ('owner', 'admin') order by role = 'owner' desc limit 1`)
    .get(user.id) as { account_id: string } | undefined
  return { id: null, account_id: acc?.account_id ?? fail(403, `${fullName} is not connected to your account yet: ask an account admin to connect it in DiffNotes`) }
}

// Replaces the pull request's annotations and files: re-running the skill after a push is idempotent.
// Body: JSON, or multipart with a `payload` JSON field plus `file` fields; `attachment:<name>` in Markdown becomes the file's URL.
app.put(PULL_PATH, async (c) => {
  let payload: unknown, files: Upload[] = []
  if ((c.req.header('content-type') ?? '').startsWith('multipart/')) {
    const form = await c.req.formData()
    const raw = form.get('payload') // curl -F payload=@file.json sends a file, -F payload='{…}' a string
    try { payload = JSON.parse(raw instanceof File ? await raw.text() : String(raw ?? '{}')) } catch { fail(400, 'payload is not JSON') }
    // all files together can't pass MAX_PULL: bodyLimit on /api/* already refuses a bigger request
    files = await Promise.all(form.getAll('file').filter((f): f is File => f instanceof File)
      .map(async (f) => ({ name: f.name, data: Buffer.from(await f.arrayBuffer()) })))
  } else payload = await json(c)
  return c.json(await savePull(c.get('user'), c.req.param('repo') ?? '', Number(c.req.param('number')), payload, files, host(c)))
})

type Upload = { name: string; data: Buffer }
type Rules = { risk?: boolean; deploy?: boolean; screenshots?: string }
// a path glob: ** any directories, * and ? within one name; matched against the whole path. A table, not a RegExp:
// *a*a*a*b as a regex backtracks for minutes on a long path, and any account owner can set one (the server would stall)
export const glob = (g: string) => {
  const parts = g.match(/\*\*\/|\*\*|\*|\?|[^*?]/g) ?? []
  return {
    // next[j]: the path from j on matches the parts after this one; ok[j]: from this one on. O(glob × path)
    test(p: string) {
      let next = Array.from({ length: p.length + 1 }, (_, j) => j === p.length), ok = [...next]
      for (let i = parts.length - 1; i >= 0; i--) {
        const t = parts[i]
        let dir = false // **/: a '/' at j or later is followed by a match
        for (let j = p.length; j >= 0; j--) {
          const c = p[j], more = j < p.length
          if (t === '**/') { dir ||= c === '/' && next[j + 1]; ok[j] = next[j] || dir }
          else if (t === '*' || t === '**') ok[j] = next[j] || (more && (t === '**' || c !== '/') && ok[j + 1])
          else ok[j] = more && (t === '?' ? c !== '/' : c === t) && next[j + 1]
        }
        ;[next, ok] = [ok, next]
      }
      return next[0]
    },
  }
}
// what an upload lacks under its repository's rules (empty: it passes)
function unmet(rules: Rules, deploy: string, notes: { path: string; risk: string | null }[], types: string[]) {
  const out: string[] = []
  if (rules.risk && notes.some((n) => !n.risk)) out.push('a risk (low, medium or high) on every note')
  if (rules.deploy && !deploy) out.push('a deploy card ("deploy": migrations, env vars, flags, the order of steps, how to roll back; or "nothing special")')
  // an attached image or video already passes: no glob runs then (up to 500 notes × 300 characters of globs)
  if (rules.screenshots && !types.some((t) => /^(image|video)\//.test(t))) {
    const globs = rules.screenshots.split(', ').map(glob), hit = notes.find((n) => globs.some((g) => g.test(n.path)))
    if (hit) out.push(`a screenshot or recording, since ${hit.path} matches ${rules.screenshots}`)
  }
  return out
}
// the one upload path, for PUT /api/v1/pulls/… and the MCP tool upload_notes
async function savePull(user: User, repo: string, number: number, raw: unknown, files: Upload[], origin: string) {
  if (!Number.isInteger(number) || number < 1) fail(400, 'Bad pull request number')
  const payload = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // a note that isn't an object (null, a string) has no path: 400 below, not a TypeError
  const list = Array.isArray(payload.annotations) ? (payload.annotations as unknown[]).map((a) => (a && typeof a === 'object' ? a : {}) as Record<string, unknown>)
    : fail(400, 'annotations must be an array')
  if (list.length > MAX_ANNOTATIONS) fail(413, `At most ${MAX_ANNOTATIONS} annotations`)
  if (files.length > MAX_FILES) fail(413, `At most ${MAX_FILES} files per pull request`)
  // every file is checked before anything changes (not even a new repository is connected for a refused upload);
  // no await from here to the transaction, so two uploads can't both see the pull request as new
  const datas = files.map((f) => f.data)
  const types = files.map((f) => fileType(f.name, f.data))
  if (datas.some((d, i) => d.length > (types[i].startsWith('video/') ? MAX_VIDEO : MAX_FILE))) fail(413, `Files up to ${MAX_FILE / MB}MB each, videos (mp4, webm) up to ${MAX_VIDEO / MB}MB`)

  const fullName = repoName(repo), { id: repoFound, account_id: accountId } = repositoryFor(fullName, number, user)
  const existing = db.prepare('select id from pulls where repository_id = ? and number = ?').get(repoFound, number) as { id: string } | undefined
  const deploy = str(payload.deploy, 20_000) // blank or not a string: no card
  const notes = list.map((a, i) => ({ path: str(a.path, 500) || fail(400, `annotations[${i}].path is required`), risk: RISKS.includes(a.risk as string) ? a.risk as string : null }))
  const rules = repoFound ? JSON.parse((db.prepare('select rules from repositories where id = ?').get(repoFound) as { rules: string }).rules) as Rules : {}
  const missing = unmet(rules, deploy, notes, types)
  if (missing.length) fail(422, `${fullName}'s rules ask for ${missing.join('; ')}. Add it and upload again.`)
  // account quotas, so one leaked token can't fill the disk: live pull requests, and file bytes (this PR's old files don't count)
  if (!existing && (db.prepare('select count(*) as n from pulls p join repositories r on r.id = p.repository_id where r.account_id = ?').get(accountId) as { n: number }).n >= MAX_PULLS)
    fail(413, `This account has ${MAX_PULLS} pull requests with notes, the most it can; delete some or wait for them to expire`)
  const used = (db.prepare(`select coalesce(sum(f.size), 0) as n from files f join pulls p on p.id = f.pull_id join repositories r on r.id = p.repository_id
    where r.account_id = ? and p.id is not ?`).get(accountId, existing?.id ?? null) as { n: number }).n
  if (used + datas.reduce((n, d) => n + d.length, 0) > MAX_ACCOUNT) fail(413, `This account's files are over ${MAX_ACCOUNT / MB}MB; delete some pull requests or wait for them to expire`)
  // connected only now: a refused upload leaves nothing behind
  const repoId = repoFound ?? randomUUID()
  if (!repoFound) db.prepare('insert into repositories (id, account_id, full_name, created_at) values (?, ?, ?, ?)').run(repoId, accountId, fullName, now())
  const id = existing?.id ?? randomUUID()
  // stored[i] is files[i]'s stored name (unique, <= 100 chars like safeName, so /files/ finds it); names maps attachment: refs
  const names = new Map<string, string>(), stored: string[] = []
  for (const f of files) {
    let name = safeName(f.name)
    while (stored.includes(name)) name = `${randomBytes(2).toString('hex')}-${name.slice(-95)}`
    stored.push(name)
    if (!names.has(f.name)) names.set(f.name, name)
  }
  const link = (md: string) => md.replace(/attachment:([^\s)"']+)/g, (m, n: string) =>
    names.has(n) ? `/files/${id}/${encodeURIComponent(names.get(n)!)}` : m)

  const summaryMd = link(String(payload.summary ?? '').slice(0, 20_000)), deployMd = link(deploy)
  const rows = list.map((a, i) => {
    const line = Number.isInteger(a.line) && (a.line as number) > 0 ? a.line as number : null
    const end = line && Number.isInteger(a.end_line) && (a.end_line as number) >= line ? a.end_line as number : null
    return [id, notes[i].path, line, end, a.side === 'LEFT' ? 'LEFT' : 'RIGHT', str(a.title, 200), link(String(a.body ?? '').slice(0, 20_000)), i, notes[i].risk] as const
  })
  // the previous upload's files go once the new rows are in, then the new files are written under the current backend
  const old = db.prepare('select pull_id as pull, name, backend from files where pull_id = ?').all(id) as { pull: string; name: string; backend: string }[]
  const backend = store.current()
  db.exec('begin')
  try {
    if (existing) {
      db.prepare('update pulls set title = ?, head_sha = ?, summary = ?, deploy = ?, user_id = ?, updated_at = ?, expires_at = ? where id = ?')
        .run(str(payload.title, 300), str(payload.head_sha, 64), summaryMd, deployMd, user.id, now(), daysFromNow(RETENTION_DAYS), id)
      db.prepare('delete from annotations where pull_id = ?').run(id)
    } else {
      db.prepare(`insert into pulls (id, repository_id, number, title, head_sha, summary, deploy, user_id, created_at, updated_at, expires_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, repoId, number, str(payload.title, 300), str(payload.head_sha, 64),
        summaryMd, deployMd, user.id, now(), now(), daysFromNow(RETENTION_DAYS))
    }
    const ins = db.prepare('insert into annotations (pull_id, path, line, end_line, side, title, body, position, risk) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const r of rows) ins.run(...r)
    db.prepare('delete from files where pull_id = ?').run(id)
    const add = db.prepare('insert into files (pull_id, name, type, size, backend) values (?, ?, ?, ?, ?)')
    for (const [i, name] of stored.entries()) add.run(id, name, types[i], datas[i].length, backend)
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
  // ponytail: rows commit before the bytes land; a failed write shows as a missing image until the next upload.
  // Two uploads of one PR at the same moment can interleave here and orphan the first one's bytes; a per-PR lock if that shows up.
  await store.remove(old)
  await Promise.all(stored.map((name, i) => store.put(backend, id, name, datas[i], types[i])))
  return { id, url: `${origin}/pulls/${id}`, annotations: rows.length, files: files.length }
}

// --- MCP: the skill's three calls as tools, so any MCP client (Claude Code, Cursor, Codex) annotates PRs without the skill.
// Streamable HTTP, stateless: one JSON-RPC 2.0 request per POST /mcp, one JSON reply. Bearer token only, never the cookie.
// ponytail: no SSE stream, sessions, batches, resources or prompts; tools are all a client needs here
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] // the newest first: the answer when a client asks for another
const target = {
  repo: { type: 'string', description: 'The repository: owner/name for GitHub, host/path for GitLab or Bitbucket (gitlab.com/group/project, bitbucket.org/team/repo); a PR URL or clone address works too' },
  number: { type: 'integer', minimum: 1, description: 'The pull request (merge request) number' },
}
const limits = () => `Files: png, jpg, gif, webp (real images) up to ${MAX_FILE / MB} MB each; mp4, webm (short screen recordings) up to ` +
  `${MAX_VIDEO / MB} MB each; md, csv, txt, html (UTF-8 text) up to ${MAX_FILE / MB} MB each. At most ${MAX_FILES} files and ` +
  `${MAX_PULL / MB} MB per pull request, ${MAX_ANNOTATIONS} notes. Every file is checked by its content; anything else is refused.`
const TOOLS = [
  {
    name: 'get_notes', title: 'Read DiffNotes notes',
    description: 'The DiffNotes notes on a pull request: summary, deploy card, head_sha, annotations (path, line, end_line, side, title, body, risk) and attached files. ' +
      'Use it before re-annotating after new commits, to keep what still applies. Bodies, the summary and the deploy card link files as /files/…: ' +
      'every upload replaces all files, so to keep one, attach it again and write it as attachment:<name>. ' +
      'Errors with "No annotations" when the PR has none.',
    inputSchema: { type: 'object', properties: target, required: ['repo', 'number'] },
  },
  {
    name: 'upload_notes', title: 'Annotate a pull request',
    description: 'Upload plain-language notes on a pull request (GitHub PR, GitLab MR, Bitbucket PR) for its reviewers; they see them inside the diff ' +
      'through the DiffNotes browser extension. Nothing is posted to GitHub, GitLab or Bitbucket. Replaces all of the PR\'s notes and files: ' +
      'send the full set every time (re-running after a push is safe).\n' +
      'Rules: notes describe the PR\'s current head commit only (set head_sha to it; re-upload after new commits). One note per changed block ' +
      '(a function, a hunk), not per line and not one per file; path and line / end_line in the new file (side RIGHT), side LEFT only for removed lines. ' +
      'Write plain words a reviewer gets without reading the code first: what changed, why, what to check. No praise, no restating the diff. ' +
      'Never put secrets or private data in notes, titles, summaries or files: API keys, passwords, tokens, private keys, connection strings, ' +
      '.env values, session cookies, personal or customer data. Crop or blur them out of screenshots and recordings; say "an API key" instead. ' +
      'risk high / medium / low only where it helps reviewers decide where to look hardest. The summary: two or three sentences, what the PR does and why. ' +
      'deploy: when shipping takes more than a merge (migrations, env vars, flags, steps in order, rollback), say so for whoever deploys it. ' +
      'An error naming the repository\'s rules lists what it requires (a risk on every note, a deploy card, screenshots): add it and upload again.\n' +
      'Markdown in body and summary. Attach files and reference them as attachment:<name>: screenshots ![Checkout on mobile](attachment:checkout.png), ' +
      'a short screen recording of a flow or animation ![Dragging a card](attachment:drag.webm), two images named …-before.png / …-after.png become a ' +
      'slider, [report](attachment:report.md) or [timings](attachment:bench.csv) open as previews, [try it](attachment:demo.html) runs a ' +
      'self-contained demo in a sandbox (no network). ' + limits(),
    inputSchema: {
      type: 'object', required: ['repo', 'number', 'payload'],
      properties: {
        ...target,
        payload: {
          type: 'object', required: ['annotations'], description: 'The notes, like diffnotes.json in the skill',
          properties: {
            title: { type: 'string', description: 'The PR title' },
            head_sha: { type: 'string', description: 'The PR head commit the notes describe' },
            summary: { type: 'string', description: 'Markdown: what the PR does and why, two or three sentences' },
            deploy: { type: 'string', description: 'Markdown deploy card for whoever ships it: migrations, new env vars, feature flags, the order of steps, how to roll back. Leave out when shipping needs nothing special' },
            annotations: {
              type: 'array', maxItems: MAX_ANNOTATIONS,
              items: {
                type: 'object', required: ['path', 'body'],
                properties: {
                  path: { type: 'string', description: 'File path in the repository' },
                  line: { type: 'integer', minimum: 1, description: 'First line of the changed block; leave out for a note on the whole file' },
                  end_line: { type: 'integer', minimum: 1, description: 'Last line of the block' },
                  side: { type: 'string', enum: ['RIGHT', 'LEFT'], description: 'RIGHT: the new file (default); LEFT: removed lines' },
                  title: { type: 'string', description: 'A few words' },
                  body: { type: 'string', description: 'Markdown, plain words' },
                  risk: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
              },
            },
          },
        },
        files: {
          type: 'array', maxItems: MAX_FILES, description: 'Attachments, referenced in Markdown as attachment:<name>. ' + limits(),
          items: {
            type: 'object', required: ['name', 'base64'],
            properties: { name: { type: 'string', description: 'File name with its extension, e.g. checkout.png' }, base64: { type: 'string', description: 'The file\'s bytes, base64' } },
          },
        },
      },
    },
  },
  {
    name: 'delete_notes', title: 'Remove DiffNotes notes',
    description: 'Removes all notes and files of a pull request, e.g. when they no longer apply. Only their uploader or an account admin can.',
    inputSchema: { type: 'object', properties: target, required: ['repo', 'number'] },
  },
]
type Args = Record<string, unknown>
const tools: Record<string, (user: User, a: Args, origin: string) => unknown> = {
  get_notes: (user, a) => pullOut(pullOf(user, a), user),
  upload_notes: (user, a, origin) => {
    // the JSON body has MAX_BODY_KB, like PUT's; the files' share of the request is bounded by bodyLimit below
    if (JSON.stringify(a.payload ?? null).length > MAX_BODY) fail(413, `payload is over ${MAX_BODY / 1024} KB`)
    const files = a.files == null ? [] : Array.isArray(a.files) ? a.files as Args[] : fail(400, 'files must be an array')
    return savePull(user, String(a.repo ?? ''), Number(a.number), a.payload, files.map((f, i) => ({
      name: str(f?.name, 300) || fail(400, `files[${i}].name is required`),
      // a data: URL works too (what a model often has at hand); its prefix would decode to garbage bytes
      data: typeof f?.base64 === 'string' ? Buffer.from(f.base64.replace(/^data:[^,]*,/, ''), 'base64') : fail(400, `files[${i}].base64 is required`),
    })), origin)
  },
  delete_notes: (user, a) => removeAll(user, pullOf(user, a)),
}
const rpcError = (c: Context, id: unknown, code: number, message: string, status = 200) =>
  c.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status as 200)
// base64 is 4/3 of the bytes: a full PR's files (MAX_PULL_MB) plus its notes (MAX_BODY_KB)
app.use('/mcp', bodyLimit({ maxSize: Math.ceil(MAX_PULL * 4 / 3) + MAX_BODY, onError: (c) => rpcError(c, null, -32600, 'Too large', 413) }))
app.get('/mcp', (c) => c.body(null, 405, { allow: 'POST' })) // no server-to-client stream
app.post('/mcp', async (c) => {
  // a browser page on another site (DNS rebinding) can't make calls, even with a token
  if (c.req.header('origin') && c.req.header('origin') !== host(c)) return rpcError(c, null, -32600, 'Origin not allowed', 403)
  // only a well-formed Bearer header: anything else (Basic, lowercase bearer) would fall through to the cookie in currentUser()
  const user = /^Bearer \S+$/.test(c.req.header('authorization') ?? '') ? await currentUser(c) : undefined
  if (!user) return rpcError(c, null, -32001, 'Send Authorization: Bearer <a DiffNotes token>, made on your account page', 401)
  const msg = await c.req.json().catch(() => undefined) as Args | undefined
  if (msg === undefined) return rpcError(c, null, -32700, 'Parse error', 400)
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return rpcError(c, null, -32600, 'One JSON-RPC 2.0 message per request')
  // notifications (initialized, cancelled) and replies to us need no answer
  if (!('id' in msg) || 'result' in msg || 'error' in msg) return c.body(null, 202)
  if (typeof msg.method !== 'string') return rpcError(c, msg.id, -32600, 'method must be a string')
  const params = (msg.params ?? {}) as Args, result = (r: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result: r })
  if (msg.method === 'initialize') return result({
    protocolVersion: MCP_VERSIONS.includes(params.protocolVersion as string) ? params.protocolVersion : MCP_VERSIONS[0],
    capabilities: { tools: {} }, serverInfo: { name: 'diffnotes', title: 'DiffNotes', version: VERSION },
    instructions: 'DiffNotes keeps plain-language notes on pull requests for their reviewers. upload_notes annotates a PR (read its rules), ' +
      'get_notes reads what is there, delete_notes removes it.',
  })
  if (msg.method === 'ping') return result({})
  if (msg.method === 'tools/list') return result({ tools: TOOLS })
  if (msg.method !== 'tools/call') return rpcError(c, msg.id, -32601, `Method not found: ${msg.method}`)
  // own keys only: `constructor`, `toString`… are on every object
  const tool = Object.hasOwn(tools, params.name as string) ? tools[params.name as string] : undefined
  if (!tool) return rpcError(c, msg.id, -32602, `Unknown tool: ${params.name}`)
  try {
    const out = await tool(user, (params.arguments ?? {}) as Args, host(c))
    return result({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out })
  } catch (e) {
    // the same refusals the HTTP API gives (404, 413, 415…), as a tool error the model can read and act on; a server
    // error (a failed bucket write) too, reported like app.onError does, rather than a reply that isn't JSON-RPC
    if (!(e instanceof HttpError)) { console.error(e); report(e as Error, c.req.routePath, c.req.method) }
    return result({ content: [{ type: 'text', text: e instanceof HttpError ? e.message : 'Server error' }], isError: true })
  }
})

// The one policy for uploaded HTML demos (the extension's demo.html uses the same): scripts and styles inline only,
// images, fonts and media from data:/blob: only; no fetch, no external files, no forms, no popups, no top navigation.
export const DEMO_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"

// Files need the same access as their pull request; sandboxed so uploaded HTML/SVG can't run on this origin.
app.get('/files/:pull/:name', async (c) => {
  const user = await currentUser(c)
  const p = db.prepare(`${PULL_SELECT} where p.id = ?`).get(c.req.param('pull')) as Pull | undefined
  if (!user || !p || !(user.admin || memberRole(p.account_id, user.id))) return c.notFound()
  const f = db.prepare('select name, type, backend from files where pull_id = ? and name = ?').get(p.id, safeName(c.req.param('name'))) as
    { name: string; type: string; backend: string } | undefined
  const data = f && await store.get(f.backend, p.id, f.name)
  if (!f || !data) return c.notFound()
  // text (md, csv, txt) is always served as plain text: the web app and the extension render it themselves.
  // HTML demos run only inside a frame, in an opaque sandbox (no cookies, no access to this origin) with every network
  // request blocked; opened as a page of its own (a link, a new tab) it is shown as source, so it can't pose as this site.
  // Videos play inline (<video>, sandboxed like images). Rows from before the allow-list (svg) are neither: they download.
  const html = f.type === 'text/html' && c.req.header('sec-fetch-dest') === 'iframe'
  const type = /^(image|video)\//.test(f.type) ? f.type : html ? 'text/html; charset=utf-8'
    : f.type.startsWith('text/') ? 'text/plain; charset=utf-8' : 'application/octet-stream'
  // re-uploading a PR keeps its file names, so caches revalidate instead of showing the old file for an hour.
  // One etag per variant: on a Vary mismatch a browser revalidates with the stored etag and reuses that stored body on a
  // 304, so a shared etag would let a framed demo's text/html come back as a page of its own.
  const etag = `"${createHash('sha256').update(data).digest('base64url').slice(0, 27)}${html ? '-demo' : ''}"`
  const headers = { etag, 'cache-control': 'private, no-cache', vary: 'sec-fetch-dest' }
  // weak comparison over the list (a proxy that compresses, like Cloudflare, hands out W/"…")
  if ((c.req.header('if-none-match') ?? '').split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) return c.body(null, 304, headers)
  // Safari plays a <video> only from a server that answers byte ranges (it asks for bytes=0-1 first).
  // ponytail: one `bytes=a-` / `bytes=a-b` range; a suffix or multi-range request gets the whole file (allowed by RFC 9110)
  // (and `bytes=5-2`, an invalid range, is ignored like RFC 9110 says; only a start past the end is a 416).
  // If-Range naming another version (a re-upload keeps the name) gets the whole file, never bytes spliced from two.
  // ponytail: every range reads the whole file (an S3 GET each); ranged reads from the backend if long videos show up
  const ifRange = c.req.header('if-range')
  const video = type.startsWith('video/'), m = video && (!ifRange || ifRange === etag) ? c.req.header('range')?.match(/^bytes=(\d+)-(\d*)$/) : null
  const range = m && !(m[2] && Number(m[2]) < Number(m[1])) ? m : null
  const start = range ? Number(range[1]) : 0, end = Math.min(range?.[2] ? Number(range[2]) : Infinity, data.length - 1)
  if (range && start > end) return c.body(null, 416, { ...headers, 'content-range': `bytes */${data.length}` })
  return c.body(new Uint8Array(data.subarray(start, end + 1)), range ? 206 : 200, {
    ...headers, 'content-type': type, 'content-security-policy': html ? DEMO_CSP : 'sandbox',
    'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${f.name}"`,
    ...(video && { 'accept-ranges': 'bytes' }), ...(range && { 'content-range': `bytes ${start}-${end}/${data.length}` }),
  })
})

// --- super admin: the people who run this server (users.admin); `npm run reset-password` restores the first one

const requireSuper = async (c: Context<Env>, next: () => Promise<void>) => {
  if (!c.get('user').admin) return c.json({ error: 'Not found' }, 404)
  await next()
}
app.use('/api/admin/*', requireSuper)

app.get('/api/admin/stats', (c) => {
  const n = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n
  const day = new Date(Date.now() - 86400_000).toISOString(), week = new Date(Date.now() - 7 * 86400_000).toISOString()
  const disk = fs.statfsSync(DATA_DIR)
  const accounts = (db.prepare(`select a.id, a.name, a.created_at,
      (select count(*) from memberships m where m.account_id = a.id) as members,
      (select count(*) from repositories r where r.account_id = a.id) as repositories,
      (select u.email from memberships m join users u on u.id = m.user_id where m.account_id = a.id and m.role = 'owner') as owner,
      (select count(*) from pulls p join repositories r on r.id = p.repository_id where r.account_id = a.id) as pulls,
      (select count(*) from files f join pulls p on p.id = f.pull_id join repositories r on r.id = p.repository_id where r.account_id = a.id) as files,
      (select coalesce(sum(f.size), 0) from files f join pulls p on p.id = f.pull_id join repositories r on r.id = p.repository_id where r.account_id = a.id) as bytes
    from accounts a order by a.created_at`).all() as { files: number; bytes: number }[])
  const users = db.prepare(`select u.id, u.email, u.name, u.admin, u.created_at,
      (select count(*) from memberships m where m.user_id = u.id) as accounts,
      (select max(t.last_used_at) from tokens t where t.user_id = u.id) as token_used_at,
      (select max(s.created_at) from sessions s where s.user_id = u.id) as signed_in_at
    from users u order by u.created_at`).all()
  return c.json({
    totals: {
      users: n('select count(*) as n from users'), accounts: accounts.length, repositories: n('select count(*) as n from repositories'),
      pulls: n('select count(*) as n from pulls'), annotations: n('select count(*) as n from annotations'),
      tokens: n('select count(*) as n from tokens'), sessions: n('select count(*) as n from sessions'),
      invites: n('select count(*) as n from invites'),
      uploads_24h: n('select count(*) as n from pulls where updated_at > ?', day), uploads_7d: n('select count(*) as n from pulls where updated_at > ?', week),
      files: accounts.reduce((n, a) => n + a.files, 0),
      upload_bytes: accounts.reduce((n, a) => n + a.bytes, 0), db_bytes: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0,
      disk_free_bytes: disk.bavail * disk.bsize, disk_total_bytes: disk.blocks * disk.bsize,
    },
    retention_days: RETENTION_DAYS, version: VERSION, accounts, users,
  })
})

// promote or demote another super admin; your own flag stays, so the server always keeps one
app.put('/api/admin/users/:id', async (c) => {
  if (c.req.param('id') === c.get('user').id) fail(400, 'You cannot change your own super admin flag')
  const res = db.prepare('update users set admin = ? where id = ?').run((await json(c)).admin === true ? 1 : 0, c.req.param('id'))
  if (!res.changes) fail(404, 'Not found')
  return c.json({ ok: true })
})

// storage settings: the secret key never leaves the server (only whether one is set); a new S3 setup is tested first
app.get('/api/admin/storage', (c) => {
  const st = getSetting<StorageSetting>('storage')
  const counts = db.prepare('select backend, count(*) as files, coalesce(sum(size), 0) as bytes from files group by backend').all()
  return c.json({ storage: st ? { ...st, secret: undefined, has_secret: !!st.secret } : { kind: 'disk' }, counts, retention_days: RETENTION_DAYS })
})
app.put('/api/admin/storage', async (c) => {
  const body = await json(c)
  if (body.kind !== 's3') { setSetting('storage', { ...(getSetting<StorageSetting>('storage') ?? {}), kind: 'disk' }); return c.json({ ok: true }) }
  const prev = getSetting<StorageSetting>('storage')
  const endpoint = str(body.endpoint, 300).replace(/\/+$/, '')
  if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(endpoint)) fail(400, 'Endpoint is the bucket service URL, e.g. https://s3.us-west-004.backblazeb2.com')
  const cfg: S3Config = {
    endpoint, region: str(body.region, 60) || 'auto', bucket: str(body.bucket, 63), key_id: str(body.key_id, 200),
    secret: String(body.secret ?? '').trim() || (prev?.secret ? unseal(prev.secret) : ''),
    prefix: str(body.prefix, 100).replace(/^\/+/, '').replace(/([^/])$/, '$1/'),
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) fail(400, 'Bucket name: 3-63 lowercase letters, digits, dots and dashes')
  // the prefix goes into URLs and the lifecycle XML: `#`, `?` or `..` would point every key somewhere else
  if (!/^([\w-][\w.-]*\/)*$/.test(cfg.prefix)) fail(400, 'Prefix: folders of letters, digits, dots, dashes and underscores, e.g. diffnotes/')
  if (!cfg.key_id || !cfg.secret) fail(400, 'Key ID and secret key are required')
  // file rows know only "s3", not which bucket: moving while files live in the old one would make them unreachable
  const moved = prev?.bucket && (prev.endpoint !== cfg.endpoint || prev.bucket !== cfg.bucket || prev.prefix !== cfg.prefix)
  if (moved && db.prepare(`select 1 from files where backend = 's3' limit 1`).get()) {
    fail(409, 'Files are still stored in the current bucket: keep its endpoint, bucket and prefix until they expire')
  }
  try { await checkS3(cfg) } catch (e) { fail(400, `Couldn't write to the bucket: ${(e as Error).message}`) }
  setSetting('storage', { ...cfg, kind: 's3', secret: seal(cfg.secret) })
  return c.json({ ok: true })
})
app.post('/api/admin/storage/lifecycle', async (c) => {
  const cfg = s3Config() ?? fail(400, 'S3 storage is not configured')
  try { await applyLifecycle(cfg, RETENTION_DAYS + 1) } catch (e) { fail(400, (e as Error).message) }
  return c.json({ ok: true, days: RETENTION_DAYS + 1 })
})

// --- skill install, health, static web app

const skill = (c: Context) => fs.readFileSync(path.join(ROOT, 'skill/diffnotes/SKILL.md'), 'utf8')
  .replaceAll('{{HOST}}', host(c))
  // this server's limits, so the agent sizes files to what it will accept
  .replaceAll('{{MAX_FILE_MB}}', String(MAX_FILE / MB)).replaceAll('{{MAX_VIDEO_MB}}', String(MAX_VIDEO / MB))
  .replaceAll('{{MAX_PULL_MB}}', String(MAX_PULL / MB)).replaceAll('{{MAX_FILES}}', String(MAX_FILES)).replaceAll('{{MAX_ANNOTATIONS}}', String(MAX_ANNOTATIONS))
app.get('/skill/SKILL.md', (c) => c.text(skill(c), 200, { 'content-type': 'text/markdown; charset=utf-8' }))
app.get('/install.sh', (c) => c.text(`#!/bin/sh
# Installs the DiffNotes skill for Claude Code (~/.claude/skills), Codex and other Agent Skills tools (~/.agents/skills) and Cursor.
set -e
for d in "$HOME/.claude/skills" "$HOME/.agents/skills" $( [ -d "$HOME/.cursor" ] && echo "$HOME/.cursor/skills" ); do
  # rm: the same skill under its name before the rename (reviews42), which would stay installed beside it, never updated
  mkdir -p "$d/diffnotes" && curl -fsSL "${host(c)}/skill/SKILL.md" -o "$d/diffnotes/SKILL.md" && echo "installed: $d/diffnotes" && rm -rf "$d/reviews42"
done
[ -z "$REVIEWS42_TOKEN" ] || echo "Rename REVIEWS42_URL / REVIEWS42_TOKEN to DIFFNOTES_URL / DIFFNOTES_TOKEN in your shell profile: the skill reads only the new names."
echo "Now set DIFFNOTES_TOKEN (make one at ${host(c)}/settings) in your shell profile."
`))
app.get('/healthz', (c) => c.text(db.prepare('select 1 as ok').get() ? 'ok' : 'down'))

// crawlers: the landing page only; the app, the API and files stay out of search (they are private anyway)
app.get('/robots.txt', (c) => c.text(`User-agent: *
Disallow: /api/
Disallow: /files/
Disallow: /dashboard
Disallow: /settings
Disallow: /admin
Disallow: /accounts/
Disallow: /pulls/
Disallow: /invite/
Disallow: /login

Sitemap: ${host(c)}/sitemap.xml
`))
app.get('/sitemap.xml', (c) => c.body(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host(c)}/</loc></url><url><loc>${host(c)}/privacy</loc></url></urlset>
`, 200, { 'content-type': 'application/xml; charset=utf-8' }))

// the web app's one page, with this server's address in its canonical and Open Graph tags (index.html: __ORIGIN__)
// and a CSP: everything from here only (no third party learns who opens the app), frames only /files demos
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
// Optional Umami analytics, on the landing page only (the app's URLs name private PRs): UMAMI_SCRIPT + UMAMI_WEBSITE_ID.
// It counts the one page view itself (web/landing.tsx), so moving on into the app is never tracked.
const umami = URL.parse(process.env.UMAMI_SCRIPT ?? ''), UMAMI_ID = process.env.UMAMI_WEBSITE_ID ?? ''
const analytics = umami?.protocol === 'https:' && /^[\w-]+$/.test(UMAMI_ID)
  ? { csp: PAGE_CSP.replace("script-src 'self'", `script-src 'self' ${umami.origin}`).replace("connect-src 'self'", `connect-src 'self' ${umami.origin}`),
      tag: `<script defer src="${umami.href.replace(/"/g, '%22')}" data-website-id="${UMAMI_ID}" data-auto-track="false"></script>` }
  : undefined
let indexHtml: string | undefined
const page = (c: Context) => {
  indexHtml ??= fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  const landing = c.req.path === '/' && analytics
  c.header('content-security-policy', landing ? analytics.csp : PAGE_CSP)
  c.header('cache-control', 'no-cache')
  if (c.req.path !== '/' && c.req.path !== '/privacy') c.header('x-robots-tag', 'noindex')
  // /privacy is indexed (sitemap.xml): its canonical and og:url are itself, not the landing page
  const html = (c.req.path === '/privacy' ? indexHtml.replace(/(rel="canonical" href|property="og:url" content)="__ORIGIN__\/"/g, '$1="__ORIGIN__/privacy"') : indexHtml)
    .replaceAll('__ORIGIN__', host(c))
  return c.html(landing ? html.replace('</head>', `${analytics.tag}\n</head>`) : html)
}
app.get('/', page)
app.get('/index.html', page)
app.use('/assets/*', serveStatic({ root: DIST, onFound: (_p, c) => c.header('cache-control', 'public, max-age=31536000, immutable') }))
app.use('*', serveStatic({ root: DIST, onFound: (_p, c) => c.header('cache-control', 'public, max-age=86400') }))
// app routes get the page; a missing file or API route is a real 404, and so is /.well-known/ (an MCP client turned away
// by /mcp looks for OAuth metadata there: a 404 says there is none, the app's HTML would fail as JSON)
app.get('*', (c) => (/\.[a-z0-9]+$|^\/(api|files|\.well-known)\//i.test(c.req.path) ? c.notFound() : page(c)))
