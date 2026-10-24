import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

export function sessionSecret() {
  const file = path.join(DATA_DIR, 'session.secret')
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
  return fs.readFileSync(file, 'utf8').trim()
}

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

export const pullDir = (pullId: string) => path.join(UPLOADS, pullId)

// ponytail: runs on boot and hourly from index.ts; a huge backlog is deleted in one statement, fine at self-hosted scale
export function purgeExpired() {
  const gone = db.prepare('delete from pulls where expires_at < ? returning id').all(now()) as { id: string }[]
  for (const { id } of gone) fs.rmSync(pullDir(id), { recursive: true, force: true })
  db.prepare('delete from invites where expires_at < ?').run(now())
  db.prepare('delete from sessions where created_at < ?').run(daysFromNow(-30)) // same 30 days currentUser() accepts
  return gone.length
}
