import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { getConnInfo } from '@hono/node-server/conninfo'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import {
  DATA_DIR, EXT_TYPES, RETENTION_DAYS, UPLOADS, bootstrap, createAccount, createUser, daysFromNow, db, getSetting, hashPassword, newToken, now, purgeExpired,
  seal, sessionSecret, setSetting, sha256, unseal, verifyPassword,
} from './db.ts'
import { applyLifecycle, checkS3, storage } from './storage.ts'
import type { S3Config } from './storage.ts'
import type { User } from './db.ts'

const SECRET = process.env.SESSION_SECRET || sessionSecret()
const MB = 1024 * 1024
const MAX_FILE = Number(process.env.MAX_FILE_MB ?? 1) * MB
const MAX_PULL = Number(process.env.MAX_PULL_MB ?? 20) * MB
const MAX_FILES = 30 // per pull request
const MAX_BODY = Number(process.env.MAX_BODY_KB ?? 1024) * 1024
const MAX_ANNOTATIONS = 500
const INVITE_DAYS = 7
const ROOT = path.resolve(import.meta.dirname, '..')
const host = (c: Context) => process.env.PUBLIC_URL ?? new URL(c.req.url).origin
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
function throttle(key: string, limit: number, windowMs: number) {
  const t = Date.now()
  if (failures.size > 10_000) for (const [k, l] of failures) if (!l.length || t - l[l.length - 1] > 600_000) failures.delete(k)
  const list = (failures.get(key) ?? []).filter((x) => t - x < windowMs)
  failures.set(key, list)
  return list.length >= limit
}
// re-reads the key: a sweep in a later throttle() call may have dropped an entry that was still empty
const recordFailure = (key: string) => failures.set(key, [...(failures.get(key) ?? []), Date.now()])
const clientIp = (c: Context) =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? (() => { try { return getConnInfo(c).remote.address } catch { return '' } })() ?? ''

app.post('/api/login', async (c) => {
  const body = await json(c)
  const email = str(body.email).toLowerCase(), keys = [`e:${email}`, `ie:${clientIp(c)}:${email}`]
  if (throttle(keys[0], 20, 600_000) || throttle(keys[1], 1, 1000)) return c.json({ error: 'Too many attempts, wait a bit' }, 429)
  const row = db.prepare('select id, password from users where email = ?').get(email) as { id: string; password: string } | undefined
  if (!verifyPassword(String(body.password ?? ''), row?.password ?? DUMMY_HASH) || !row) {
    keys.forEach(recordFailure)
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

const accountsOf = (userId: string) => db.prepare(`select a.id, a.name, m.role from accounts a join memberships m on m.account_id = a.id
  where m.user_id = ? order by a.created_at`).all(userId)
const tokenCount = (userId: string) => (db.prepare('select count(*) as n from tokens where user_id = ?').get(userId) as { n: number }).n

// who is signed in, plus what the app layout shows around every page: their accounts and whether they have a token yet
app.get('/api/me', async (c) => {
  const user = await currentUser(c)
  if (!user) return c.json({ user: null })
  return c.json({ user, accounts: accountsOf(user.id), tokens: tokenCount(user.id) })
})

// --- invitations: the only way in besides the first admin

const inviteRow = (token: string) => db.prepare(`select i.*, a.name as account from invites i join accounts a on a.id = i.account_id
  where i.token = ? and i.expires_at > ?`).get(token, now()) as { account_id: string; email: string; role: string; account: string } | undefined

app.get('/api/invites/:token', (c) => {
  const inv = inviteRow(c.req.param('token')) ?? fail(404, 'This invitation is invalid or expired')
  const exists = !!db.prepare('select 1 from users where email = ?').get(inv.email)
  return c.json({ email: inv.email, account: inv.account, exists })
})

app.post('/api/invites/:token/accept', async (c) => {
  const token = c.req.param('token'), body = await json(c)
  const inv = inviteRow(token) ?? fail(404, 'This invitation is invalid or expired')
  const password = String(body.password ?? '')
  let user = db.prepare('select id, password from users where email = ?').get(inv.email) as { id: string; password: string } | undefined
  if (user) { // same per-email budget as /api/login, or a shared invite link would allow unlimited password guesses
    const key = `e:${inv.email.toLowerCase()}`
    if (throttle(key, 20, 600_000)) fail(429, 'Too many attempts, wait a bit')
    if (!verifyPassword(password, user.password)) { recordFailure(key); fail(401, 'Wrong password') }
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

app.put('/api/password', async (c) => {
  const body = await json(c), user = c.get('user')
  const row = db.prepare('select password from users where id = ?').get(user.id) as { password: string }
  if (!verifyPassword(String(body.current ?? ''), row.password)) fail(401, 'Current password is wrong')
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
// (reads and uploads). A super admin (users.admin) runs the server and may open and manage every account.
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
  const repositories = db.prepare(`select r.id, r.full_name, (select count(*) from pulls p where p.repository_id = r.id) as pulls
    from repositories r where r.account_id = ? order by r.full_name`).all(id)
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
app.delete('/api/accounts/:id', async (c) => {
  const id = c.req.param('id'), user = c.get('user')
  if (role(id, user) !== 'owner' && !user.admin) fail(403, 'Only the owner can delete the account')
  const pulls = db.prepare('select p.id from pulls p join repositories r on r.id = p.repository_id where r.account_id = ?').all(id) as { id: string }[]
  // dropPulls deletes the PR rows before its first await; the account goes in the same tick, so no upload can add a PR
  // whose files the cascade would then leave behind, and a slow bucket only delays the response, not the delete
  const dropped = dropPulls(pulls.map((p) => p.id))
  db.prepare('delete from accounts where id = ?').run(id)
  await dropped
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

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
app.post('/api/accounts/:id/repositories', async (c) => {
  const id = c.req.param('id'), name = str((await json(c)).full_name).replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '')
  requireAdmin(id, c.get('user'))
  if (!REPO.test(name)) fail(400, 'Use owner/name, e.g. rails/rails')
  if (db.prepare('select 1 from repositories where full_name = ?').get(name)) fail(409, 'This repository is already connected')
  const repo = randomUUID()
  db.prepare('insert into repositories (id, account_id, full_name, created_at) values (?, ?, ?, ?)').run(repo, id, name, now())
  return c.json({ id: repo })
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

type Pull = { id: string; number: number; title: string; head_sha: string; summary: string; updated_at: string; expires_at: string; full_name: string; account_id: string }
const PULL_SELECT = `select p.id, p.number, p.title, p.head_sha, p.summary, p.updated_at, p.expires_at, r.full_name, r.account_id
  from pulls p join repositories r on r.id = p.repository_id`

function pullOut(p: Pull) {
  const annotations = db.prepare('select path, line, end_line, side, title, body from annotations where pull_id = ? order by position').all(p.id)
  const files = (db.prepare('select name, type, size from files where pull_id = ? order by name').all(p.id) as { name: string; type: string; size: number }[])
    .map((f) => ({ ...f, url: `/files/${p.id}/${encodeURIComponent(f.name)}` }))
  return {
    id: p.id, repository: p.full_name, number: p.number, title: p.title, head_sha: p.head_sha, summary: p.summary,
    updated_at: p.updated_at, expires_at: p.expires_at, annotations, files,
  }
}

const findPull = (c: Context<Env>) => {
  const full = `${c.req.param('owner')}/${c.req.param('repo')}`
  const p = db.prepare(`${PULL_SELECT} where r.full_name = ? and p.number = ?`).get(full, Number(c.req.param('number'))) as Pull | undefined
  if (!p) fail(404, 'No annotations for this pull request')
  role(p!.account_id, c.get('user'))
  return p!
}

app.get('/api/v1/me', (c) => c.json({ user: c.get('user') }))
app.get('/api/v1/pulls/:owner/:repo/:number', (c) => c.json(pullOut(findPull(c))))
app.get('/api/pulls/:id', (c) => {
  const p = db.prepare(`${PULL_SELECT} where p.id = ?`).get(c.req.param('id')) as Pull | undefined
  if (!p) fail(404, 'Not found')
  role(p!.account_id, c.get('user'))
  return c.json(pullOut(p!))
})
app.delete('/api/v1/pulls/:owner/:repo/:number', async (c) => {
  const p = findPull(c)
  await dropPulls([p.id])
  return c.json({ ok: true })
})

// cut from the front, so a long name keeps the extension fileType() checked (else `….html.png` would be stored as `….html`)
const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100).replace(/^\.+/, '') || 'file'

// Uploads are checked by content, not only by name: images must start with their format's signature, text files must be
// UTF-8 without NUL bytes (html too: it only ever runs as a sandboxed demo). SVG, PDF, archives and anything else are refused.
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}
const utf8 = new TextDecoder('utf-8', { fatal: true })
export function fileType(name: string, data: Buffer) {
  const type = EXT_TYPES[path.extname(name).slice(1).toLowerCase()]
  if (!type) fail(415, `${name}: only png, jpg, gif, webp, csv, md, txt and html files are accepted`)
  if (type.startsWith('image/')) {
    if (!MAGIC[type](data)) fail(415, `${name}: not a valid ${type.slice(6)} image`)
  } else {
    try { utf8.decode(data) } catch { fail(415, `${name}: text files must be UTF-8`) }
    if (data.includes(0)) fail(415, `${name}: text files can't contain NUL bytes`)
  }
  return type
}

// The repository must be connected to an account you're in; an unknown one is connected to your first owned account.
function repositoryFor(fullName: string, user: User) {
  if (!REPO.test(fullName)) fail(400, 'Bad repository name')
  const repo = db.prepare('select id, account_id from repositories where full_name = ?').get(fullName) as { id: string; account_id: string } | undefined
  if (repo) return role(repo.account_id, user) && repo.id
  const acc = db.prepare(`select account_id from memberships where user_id = ? order by role in ('owner', 'admin') desc limit 1`).get(user.id) as { account_id: string } | undefined
  if (!acc) fail(403, 'You are not in any account')
  const id = randomUUID()
  db.prepare('insert into repositories (id, account_id, full_name, created_at) values (?, ?, ?, ?)').run(id, acc!.account_id, fullName, now())
  return id
}

// Replaces the pull request's annotations and files: re-running the skill after a push is idempotent.
// Body: JSON, or multipart with a `payload` JSON field plus `file` fields; `attachment:<name>` in Markdown becomes the file's URL.
app.put('/api/v1/pulls/:owner/:repo/:number', async (c) => {
  const user = c.get('user'), number = Number(c.req.param('number'))
  if (!Number.isInteger(number) || number < 1) fail(400, 'Bad pull request number')
  let payload: Record<string, unknown>, files: File[] = []
  if ((c.req.header('content-type') ?? '').startsWith('multipart/')) {
    const form = await c.req.formData()
    const raw = form.get('payload') // curl -F payload=@file.json sends a file, -F payload='{…}' a string
    try { payload = JSON.parse(raw instanceof File ? await raw.text() : String(raw ?? '{}')) ?? {} } catch { fail(400, 'payload is not JSON') }
    files = form.getAll('file').filter((f): f is File => f instanceof File)
  } else payload = await json(c)
  const list = Array.isArray(payload!.annotations) ? payload!.annotations as Record<string, unknown>[] : fail(400, 'annotations must be an array')
  if (list.length > MAX_ANNOTATIONS) fail(413, `At most ${MAX_ANNOTATIONS} annotations`)
  if (files.length > MAX_FILES) fail(413, `At most ${MAX_FILES} files per pull request`)
  if (files.some((f) => f.size > MAX_FILE)) fail(413, `Files up to ${MAX_FILE / MB}MB each`)
  if (files.reduce((n, f) => n + f.size, 0) > MAX_PULL) fail(413, `Up to ${MAX_PULL / MB}MB of files per pull request`)
  // read and check every file before anything changes (not even a new repository is connected for a refused upload);
  // also the last await before the transaction, so two uploads can't both see the pull request as new
  const datas = await Promise.all(files.map(async (f) => Buffer.from(await f.arrayBuffer())))
  const types = files.map((f, i) => fileType(f.name, datas[i]))

  const repoId = repositoryFor(`${c.req.param('owner')}/${c.req.param('repo')}`, user)
  const existing = db.prepare('select id from pulls where repository_id = ? and number = ?').get(repoId, number) as { id: string } | undefined
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

  const rows = list.map((a, i) => {
    const line = Number.isInteger(a.line) && (a.line as number) > 0 ? a.line as number : null
    const end = line && Number.isInteger(a.end_line) && (a.end_line as number) >= line ? a.end_line as number : null
    return [id, str(a.path, 500) || fail(400, `annotations[${i}].path is required`), line, end,
      a.side === 'LEFT' ? 'LEFT' : 'RIGHT', str(a.title, 200), link(String(a.body ?? '').slice(0, 20_000)), i] as const
  })
  // the previous upload's files go once the new rows are in, then the new files are written under the current backend
  const old = db.prepare('select pull_id as pull, name, backend from files where pull_id = ?').all(id) as { pull: string; name: string; backend: string }[]
  const backend = store.current()
  db.exec('begin')
  try {
    if (existing) {
      db.prepare('update pulls set title = ?, head_sha = ?, summary = ?, user_id = ?, updated_at = ?, expires_at = ? where id = ?')
        .run(str(payload!.title, 300), str(payload!.head_sha, 64), link(String(payload!.summary ?? '').slice(0, 20_000)), user.id, now(), daysFromNow(RETENTION_DAYS), id)
      db.prepare('delete from annotations where pull_id = ?').run(id)
    } else {
      db.prepare(`insert into pulls (id, repository_id, number, title, head_sha, summary, user_id, created_at, updated_at, expires_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, repoId, number, str(payload!.title, 300), str(payload!.head_sha, 64),
        link(String(payload!.summary ?? '').slice(0, 20_000)), user.id, now(), now(), daysFromNow(RETENTION_DAYS))
    }
    const ins = db.prepare('insert into annotations (pull_id, path, line, end_line, side, title, body, position) values (?, ?, ?, ?, ?, ?, ?, ?)')
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
  return c.json({ id, url: `${host(c)}/pulls/${id}`, annotations: rows.length, files: files.length })
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
  // Rows from before the allow-list (svg, video) are neither: they download.
  const html = f.type === 'text/html' && c.req.header('sec-fetch-dest') === 'iframe'
  const type = f.type.startsWith('image/') ? f.type : html ? 'text/html; charset=utf-8'
    : f.type.startsWith('text/') ? 'text/plain; charset=utf-8' : 'application/octet-stream'
  // re-uploading a PR keeps its file names, so caches revalidate instead of showing the old file for an hour.
  // One etag per variant: on a Vary mismatch a browser revalidates with the stored etag and reuses that stored body on a
  // 304, so a shared etag would let a framed demo's text/html come back as a page of its own.
  const etag = `"${createHash('sha256').update(data).digest('base64url').slice(0, 27)}${html ? '-demo' : ''}"`
  const headers = { etag, 'cache-control': 'private, no-cache', vary: 'sec-fetch-dest' }
  // weak comparison over the list (a proxy that compresses, like Cloudflare, hands out W/"…")
  if ((c.req.header('if-none-match') ?? '').split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) return c.body(null, 304, headers)
  return c.body(new Uint8Array(data), 200, {
    ...headers, 'content-type': type, 'content-security-policy': html ? DEMO_CSP : 'sandbox',
    'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${f.name}"`,
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
  const dbFile = path.join(DATA_DIR, 'reviews42.db')
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
      upload_bytes: accounts.reduce((n, a) => n + a.bytes, 0), db_bytes: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0,
      disk_free_bytes: disk.bavail * disk.bsize, disk_total_bytes: disk.blocks * disk.bsize,
    },
    retention_days: RETENTION_DAYS, accounts, users,
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
  if (!/^([\w-][\w.-]*\/)*$/.test(cfg.prefix)) fail(400, 'Prefix: folders of letters, digits, dots, dashes and underscores, e.g. reviews42/')
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

const skill = (c: Context) => fs.readFileSync(path.join(ROOT, 'skill/reviews42/SKILL.md'), 'utf8')
  .replaceAll('{{HOST}}', host(c))
app.get('/skill/SKILL.md', (c) => c.text(skill(c), 200, { 'content-type': 'text/markdown; charset=utf-8' }))
app.get('/install.sh', (c) => c.text(`#!/bin/sh
# Installs the Reviews42 skill for Claude Code (~/.claude/skills), Codex and other Agent Skills tools (~/.agents/skills) and Cursor.
set -e
for d in "$HOME/.claude/skills" "$HOME/.agents/skills" $( [ -d "$HOME/.cursor" ] && echo "$HOME/.cursor/skills" ); do
  mkdir -p "$d/reviews42" && curl -fsSL "${host(c)}/skill/SKILL.md" -o "$d/reviews42/SKILL.md" && echo "installed: $d/reviews42"
done
echo "Now set REVIEWS42_TOKEN (make one at ${host(c)}/settings) in your shell profile."
`))
app.get('/healthz', (c) => c.text(db.prepare('select 1 as ok').get() ? 'ok' : 'down'))

app.use('/assets/*', serveStatic({ root: DIST, onFound: (_p, c) => c.header('cache-control', 'public, max-age=31536000, immutable') }))
app.use('*', serveStatic({ root: DIST, rewriteRequestPath: (p) => (/\.[a-z0-9]+$/i.test(p) ? p : '/index.html'),
  onFound: (_p, c) => c.header('cache-control', 'no-cache') }))
