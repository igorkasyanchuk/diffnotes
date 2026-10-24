import { randomBytes, randomUUID } from 'node:crypto'
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
  RETENTION_DAYS, bootstrap, createAccount, createUser, daysFromNow, db, hashPassword, newToken, now, pullDir, sessionSecret, sha256, verifyPassword,
} from './db.ts'
import type { User } from './db.ts'

const SECRET = process.env.SESSION_SECRET || sessionSecret()
const MB = 1024 * 1024
const MAX_FILE = Number(process.env.MAX_FILE_MB ?? 10) * MB
const MAX_PULL = Number(process.env.MAX_PULL_MB ?? 50) * MB
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

app.get('/api/me', async (c) => {
  const user = await currentUser(c)
  return c.json({ user: user ?? null })
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
  // an owner invite upgrades an existing member; a member invite never downgrades an owner
  db.prepare(`insert into memberships (account_id, user_id, role) values (?, ?, ?)
    on conflict do update set role = excluded.role where excluded.role = 'owner'`).run(inv.account_id, user.id, inv.role)
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
  const body = await json(c), user = c.get('user')
  const count = (db.prepare('select count(*) as n from tokens where user_id = ?').get(user.id) as { n: number }).n
  if (count >= 50) fail(409, 'Too many tokens, delete some first')
  return c.json({ token: newToken(user.id, str(body.name, 60) || `token ${count + 1}`) })
})
app.delete('/api/tokens/:id', (c) => {
  db.prepare('delete from tokens where id = ? and user_id = ?').run(c.req.param('id'), c.get('user').id)
  return c.json({ ok: true })
})

// role of the user in an account, or 404 (other people's accounts don't exist for you)
function role(accountId: string, user: User) {
  const m = db.prepare('select role from memberships where account_id = ? and user_id = ?').get(accountId, user.id) as { role: string } | undefined
  return m?.role ?? fail(404, 'Not found')
}
const requireOwner = (accountId: string, user: User) => {
  if (role(accountId, user) !== 'owner' && !user.admin) fail(403, 'Only account owners can do that')
}

app.get('/api/dashboard', (c) => {
  const user = c.get('user')
  const accounts = db.prepare(`select a.id, a.name, m.role from accounts a join memberships m on m.account_id = a.id
    where m.user_id = ? order by a.created_at`).all(user.id)
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
  const invites = my === 'owner' || user.admin
    ? db.prepare('select token, email, role, expires_at from invites where account_id = ? order by created_at desc').all(id) : []
  return c.json({ account, role: my, members, repositories, invites })
})

app.post('/api/accounts/:id/invites', async (c) => {
  const id = c.req.param('id'), user = c.get('user'), body = await json(c)
  requireOwner(id, user)
  const email = str(body.email).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(400, 'Enter an email address')
  const token = randomBytes(24).toString('base64url')
  db.prepare('insert into invites (token, account_id, email, role, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)')
    .run(token, id, email, body.role === 'owner' ? 'owner' : 'member', user.id, now(), daysFromNow(INVITE_DAYS))
  return c.json({ token })
})
app.delete('/api/accounts/:id/invites/:token', (c) => {
  requireOwner(c.req.param('id'), c.get('user'))
  db.prepare('delete from invites where token = ? and account_id = ?').run(c.req.param('token'), c.req.param('id'))
  return c.json({ ok: true })
})
app.delete('/api/accounts/:id/members/:user', (c) => {
  const id = c.req.param('id'), user = c.get('user')
  requireOwner(id, user)
  if (c.req.param('user') === user.id) fail(400, 'You cannot remove yourself')
  db.prepare('delete from memberships where account_id = ? and user_id = ?').run(id, c.req.param('user'))
  return c.json({ ok: true })
})

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
app.post('/api/accounts/:id/repositories', async (c) => {
  const id = c.req.param('id'), name = str((await json(c)).full_name).replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '')
  role(id, c.get('user'))
  if (!REPO.test(name)) fail(400, 'Use owner/name, e.g. rails/rails')
  if (db.prepare('select 1 from repositories where full_name = ?').get(name)) fail(409, 'This repository is already connected')
  const repo = randomUUID()
  db.prepare('insert into repositories (id, account_id, full_name, created_at) values (?, ?, ?, ?)').run(repo, id, name, now())
  return c.json({ id: repo })
})
app.delete('/api/repositories/:id', (c) => {
  const repo = db.prepare('select id, account_id from repositories where id = ?').get(c.req.param('id')) as { id: string; account_id: string } | undefined
  if (!repo) fail(404, 'Not found')
  requireOwner(repo!.account_id, c.get('user'))
  const pulls = db.prepare('select id from pulls where repository_id = ?').all(repo!.id) as { id: string }[]
  db.prepare('delete from repositories where id = ?').run(repo!.id)
  for (const p of pulls) fs.rmSync(pullDir(p.id), { recursive: true, force: true })
  return c.json({ ok: true })
})

// --- pull request annotations (the skill writes, the extension and the web app read)

type Pull = { id: string; number: number; title: string; head_sha: string; summary: string; updated_at: string; expires_at: string; full_name: string; account_id: string }
const PULL_SELECT = `select p.id, p.number, p.title, p.head_sha, p.summary, p.updated_at, p.expires_at, r.full_name, r.account_id
  from pulls p join repositories r on r.id = p.repository_id`

function pullOut(p: Pull) {
  const annotations = db.prepare('select path, line, end_line, side, title, body from annotations where pull_id = ? order by position').all(p.id)
  const files = fs.existsSync(pullDir(p.id)) ? fs.readdirSync(pullDir(p.id)) : []
  return {
    id: p.id, repository: p.full_name, number: p.number, title: p.title, head_sha: p.head_sha, summary: p.summary,
    updated_at: p.updated_at, expires_at: p.expires_at, annotations, files: files.map((f) => `/files/${p.id}/${encodeURIComponent(f)}`),
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
app.delete('/api/v1/pulls/:owner/:repo/:number', (c) => {
  const p = findPull(c)
  db.prepare('delete from pulls where id = ?').run(p.id)
  fs.rmSync(pullDir(p.id), { recursive: true, force: true })
  return c.json({ ok: true })
})

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file'

// The repository must be connected to an account you're in; an unknown one is connected to your first owned account.
function repositoryFor(fullName: string, user: User) {
  if (!REPO.test(fullName)) fail(400, 'Bad repository name')
  const repo = db.prepare('select id, account_id from repositories where full_name = ?').get(fullName) as { id: string; account_id: string } | undefined
  if (repo) return role(repo.account_id, user) && repo.id
  const acc = db.prepare(`select account_id from memberships where user_id = ? order by role = 'owner' desc limit 1`).get(user.id) as { account_id: string } | undefined
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
  if (files.some((f) => f.size > MAX_FILE)) fail(413, `Files up to ${MAX_FILE / MB}MB`)
  if (files.reduce((n, f) => n + f.size, 0) > MAX_PULL) fail(413, `Up to ${MAX_PULL / MB}MB of files per pull request`)

  const repoId = repositoryFor(`${c.req.param('owner')}/${c.req.param('repo')}`, user)
  const existing = db.prepare('select id from pulls where repository_id = ? and number = ?').get(repoId, number) as { id: string } | undefined
  const id = existing?.id ?? randomUUID(), dir = pullDir(id)
  // stored[i] is files[i]'s name on disk (unique, <= 100 chars like safeName, so /files/ finds it); names maps attachment: refs
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
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
  fs.rmSync(dir, { recursive: true, force: true })
  if (files.length) fs.mkdirSync(dir, { recursive: true })
  for (const [i, f] of files.entries()) fs.writeFileSync(path.join(dir, stored[i]), Buffer.from(await f.arrayBuffer()))
  return c.json({ id, url: `${host(c)}/pulls/${id}`, annotations: rows.length, files: files.length })
})

// Files need the same access as their pull request; sandboxed so uploaded HTML/SVG can't run on this origin.
app.get('/files/:pull/:name', async (c) => {
  const user = await currentUser(c)
  const p = db.prepare(`${PULL_SELECT} where p.id = ?`).get(c.req.param('pull')) as Pull | undefined
  if (!user || !p || !db.prepare('select 1 from memberships where account_id = ? and user_id = ?').get(p.account_id, user.id)) return c.notFound()
  const file = path.join(pullDir(p.id), safeName(c.req.param('name')))
  if (!fs.existsSync(file)) return c.notFound()
  const ext = path.extname(file).slice(1).toLowerCase()
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json' }[ext]
  return c.body(fs.readFileSync(file), 200, {
    'content-type': type ?? 'application/octet-stream', 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=3600',
  })
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
