import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// the only uploads accepted: extension → content type (text is served as text/plain, never rendered as HTML)
export const EXT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  csv: 'text/csv', md: 'text/markdown', txt: 'text/plain',
}

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data')
export const UPLOADS = path.join(DATA_DIR, 'uploads')
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30)
fs.mkdirSync(UPLOADS, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'reviews42.db'))
db.exec(`
  pragma busy_timeout = 5000;
  pragma journal_mode = wal;
  pragma foreign_keys = on;
  create table if not exists users (
    id text primary key, email text not null unique collate nocase, name text not null default '',
    password text not null, admin integer not null default 0, created_at text not null);
  create table if not exists sessions (
    id text primary key, user_id text not null references users(id) on delete cascade, created_at text not null);
  create table if not exists accounts (id text primary key, name text not null, created_at text not null);
  create table if not exists memberships (
    account_id text not null references accounts(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    role text not null default 'member', primary key (account_id, user_id));
  create table if not exists invites (
    token text primary key, account_id text not null references accounts(id) on delete cascade,
    email text not null collate nocase, role text not null default 'member',
    created_by text references users(id) on delete set null, created_at text not null, expires_at text not null);
  create table if not exists tokens (
    id text primary key, user_id text not null references users(id) on delete cascade,
    name text not null, hash text not null unique, created_at text not null, last_used_at text);
  create table if not exists repositories (
    id text primary key, account_id text not null references accounts(id) on delete cascade,
    full_name text not null collate nocase unique, created_at text not null);
  create table if not exists pulls (
    id text primary key, repository_id text not null references repositories(id) on delete cascade,
    number integer not null, title text not null default '', head_sha text not null default '', summary text not null default '',
    user_id text references users(id) on delete set null, created_at text not null, updated_at text not null, expires_at text not null,
    unique (repository_id, number));
  create table if not exists annotations (
    id integer primary key autoincrement, pull_id text not null references pulls(id) on delete cascade,
    path text not null, line integer, end_line integer, side text not null default 'RIGHT',
    title text not null default '', body text not null default '', position integer not null default 0);
  create index if not exists annotations_pull on annotations(pull_id);
  -- uploaded files: bytes live on disk or in S3 (backend), this row is what quotas, stats and /files read
  create table if not exists files (
    pull_id text not null references pulls(id) on delete cascade, name text not null, type text not null,
    size integer not null, backend text not null default 'disk', primary key (pull_id, name));
  -- server-wide settings a super admin changes on /admin (JSON values)
  create table if not exists settings (key text primary key, value text not null);
  -- the first release invited co-owners; an account has one owner now, so pending owner invites make admins
  update invites set role = 'admin' where role = 'owner';
`)

export const now = () => new Date().toISOString()
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const daysFromNow = (d: number) => new Date(Date.now() + d * 86400_000).toISOString()

export type User = { id: string; email: string; name: string; admin: number }

export function hashPassword(password: string) {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  const a = scryptSync(password, Buffer.from(salt, 'hex'), 64), b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

// Of two containers booting side by side (a deploy), the first one wins and both read its value. Written to a temp
// file and hard-linked into place: the link is atomic, so the other one never reads a created-but-still-empty file.
function secret(name: string) {
  const file = path.join(DATA_DIR, name)
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${randomBytes(6).toString('hex')}`
    fs.writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600 })
    try { fs.linkSync(tmp, file) } catch {} finally { fs.rmSync(tmp, { force: true }) }
  }
  return fs.readFileSync(file, 'utf8').trim()
}
export const sessionSecret = () => secret('session.secret')

// Secrets kept in settings (the S3 secret key): AES-256-GCM under ENCRYPTION_KEY, else DATA_DIR/encryption.key, so a
// copy of the DB alone doesn't give them away.
let key: Buffer | undefined
const sealKey = () => (key ??= createHash('sha256').update(process.env.ENCRYPTION_KEY || secret('encryption.key')).digest())
export function seal(text: string) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', sealKey(), iv)
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return `v1:${Buffer.concat([iv, c.getAuthTag(), data]).toString('base64')}`
}
export function unseal(sealed: string) {
  const b = Buffer.from(sealed.replace(/^v1:/, ''), 'base64')
  const d = createDecipheriv('aes-256-gcm', sealKey(), b.subarray(0, 12))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
}

export const getSetting = <T>(k: string): T | null => {
  const row = db.prepare('select value from settings where key = ?').get(k) as { value: string } | undefined
  return row ? JSON.parse(row.value) : null
}
export const setSetting = (k: string, v: unknown) =>
  db.prepare('insert into settings (key, value) values (?, ?) on conflict do update set value = excluded.value').run(k, JSON.stringify(v))

export function createUser(email: string, password: string, name = '', admin = 0) {
  const id = randomUUID()
  db.prepare('insert into users (id, email, name, password, admin, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(id, email.trim(), name.trim(), hashPassword(password), admin, now())
  return id
}

export function createAccount(name: string, ownerId: string) {
  const id = randomUUID()
  db.prepare('insert into accounts (id, name, created_at) values (?, ?, ?)').run(id, name, now())
  db.prepare(`insert into memberships (account_id, user_id, role) values (?, ?, 'owner')`).run(id, ownerId)
  return id
}

// First boot: no users yet, so the first admin and their account come from the env (or a printed random password).
export function bootstrap(email: string, password: string) {
  if (db.prepare('select 1 from users limit 1').get()) return
  const pass = password || randomBytes(9).toString('base64url')
  const id = createUser(email, pass, 'Admin', 1)
  createAccount('My team', id)
  if (!password) console.log(`first admin: ${email} / ${pass} (change it on /settings)`)
}

export function newToken(userId: string, name: string) {
  const token = `r42_${randomBytes(24).toString('base64url')}`
  db.prepare('insert into tokens (id, user_id, name, hash, created_at) values (?, ?, ?, ?, ?)')
    .run(randomUUID(), userId, name, sha256(token), now())
  return token
}


// Expired pull requests and stale invites/sessions; returns the expired pull ids for the caller to drop with their files.
export function purgeExpired() {
  const ids = (db.prepare('select id from pulls where expires_at < ?').all(now()) as { id: string }[]).map((r) => r.id)
  db.prepare('delete from invites where expires_at < ?').run(now())
  db.prepare('delete from sessions where created_at < ?').run(daysFromNow(-30)) // same 30 days currentUser() accepts
  return ids
}

// Files written before the files table existed: one row per file found on disk, once.
for (const pull of fs.readdirSync(UPLOADS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
  if (!db.prepare('select 1 from pulls where id = ?').get(pull)) continue
  for (const f of fs.readdirSync(path.join(UPLOADS, pull), { withFileTypes: true }).filter((e) => e.isFile())) {
    const ext = path.extname(f.name).slice(1).toLowerCase()
    db.prepare(`insert or ignore into files (pull_id, name, type, size, backend) values (?, ?, ?, ?, 'disk')`)
      .run(pull, f.name, EXT_TYPES[ext] ?? 'application/octet-stream', fs.statSync(path.join(UPLOADS, pull, f.name)).size)
  }
}
