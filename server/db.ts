import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// the only uploads accepted: extension → content type (text is served as text/plain; html renders only as a framed,
// sandboxed demo, see /files in app.ts; videos are short screen recordings, MAX_VIDEO_MB each)
export const EXT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', csv: 'text/csv', md: 'text/markdown', txt: 'text/plain', html: 'text/html',
}

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data')
export const UPLOADS = path.join(DATA_DIR, 'uploads')
// a blank or bad value is the default, like the MAX_* limits: 0 would expire every upload at once, NaN fail every upload
const retention = Number(process.env.RETENTION_DAYS || 365)
export const RETENTION_DAYS = retention > 0 ? retention : 365
fs.mkdirSync(UPLOADS, { recursive: true })

export const DB_FILE = path.join(DATA_DIR, 'diffnotes.db')
// The project was called reviews42: take over its database (and its WAL files) on the first start after the rename.
// ponytail: one way: an image from before the rename would open an empty reviews42.db (rollback: rename it back first)
for (const ext of ['-wal', '-shm', '']) { // the main file last: its new name is what marks the move as done
  const old = path.join(DATA_DIR, `reviews42.db${ext}`)
  if (fs.existsSync(old) && !fs.existsSync(DB_FILE)) fs.renameSync(old, DB_FILE + ext)
}
export const db = new DatabaseSync(DB_FILE)
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
    full_name text not null collate nocase, created_at text not null, unique (account_id, full_name));
  create table if not exists pulls (
    id text primary key, repository_id text not null references repositories(id) on delete cascade,
    number integer not null, title text not null default '', head_sha text not null default '', summary text not null default '',
    user_id text references users(id) on delete set null, created_at text not null, updated_at text not null, expires_at text not null,
    unique (repository_id, number));
  create table if not exists annotations (
    id integer primary key autoincrement, pull_id text not null references pulls(id) on delete cascade,
    path text not null, line integer, end_line integer, side text not null default 'RIGHT',
    title text not null default '', body text not null default '', position integer not null default 0, risk text);
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

// Repository names were unique server-wide, so whoever connected a name first locked every other account out of it.
// Now they're unique per account: rebuild the table once (SQLite can't drop a constraint), keeping ids so pulls stay linked.
if ((db.prepare("select sql from sqlite_master where name = 'repositories'").get() as { sql: string }).sql.includes('nocase unique')) {
  db.exec('pragma foreign_keys = off; begin immediate')
  try {
    if ((db.prepare("select sql from sqlite_master where name = 'repositories'").get() as { sql: string }).sql.includes('nocase unique')) db.exec(`
      create table repositories_new (
        id text primary key, account_id text not null references accounts(id) on delete cascade,
        full_name text not null collate nocase, created_at text not null, unique (account_id, full_name));
      insert into repositories_new select id, account_id, full_name, created_at from repositories;
      drop table repositories;
      alter table repositories_new rename to repositories;`)
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e } finally { db.exec('pragma foreign_keys = on') }
}

// columns that came later, added to databases made before them: risk, the deploy card, repository rules (JSON), GitHub sign-in and invites
for (const sql of ['alter table annotations add column risk text', "alter table pulls add column deploy text not null default ''",
  "alter table repositories add column rules text not null default '{}'", 'alter table users add column github_id text',
  // a GitHub login (lowercase) as of the user's last GitHub sign-in; an invite by login has email '' and this set
  'alter table users add column github_login text', 'alter table invites add column github text',
  // an open link (email ''): anyone who has it joins until it expires, any number of people
  'alter table invites add column open integer not null default 0',
  // when the user's agent (skill, MCP) and browser extension first used a token: the web app's setup checklist ticks them (notes_at below)
  'alter table users add column agent_at text', 'alter table users add column extension_at text',
  // the PR's preview deploy (https URL) and its stack (JSON [{number, title}], bottom first); a note's path on the preview
  "alter table pulls add column preview text not null default ''", "alter table pulls add column stack text not null default ''",
  'alter table annotations add column try_path text'])
  try { db.exec(sql) } catch (e) { if (!/duplicate column/.test(String(e))) throw e }
db.exec('create unique index if not exists users_github on users(github_id)')
// every note and file has its author: an upload replaces only the uploader's own. Rows from before were all the PR's
// last uploader's (each upload replaced everything); filled once, as the column is added, in one transaction (a stop
// in between would leave the column there and the rows authorless for good)
// pulls.fields_by: who wrote the PR's title, summary and deploy card (null: several people), so the live demo shows only a super admin's
for (const [t, col, fill] of [['annotations', 'user_id', '(select p.user_id from pulls p where p.id = annotations.pull_id)'],
  ['files', 'user_id', '(select p.user_id from pulls p where p.id = files.pull_id)'], ['pulls', 'fields_by', 'user_id']]) {
  db.exec('begin')
  try {
    db.exec(`alter table ${t} add column ${col} text references users(id) on delete set null`)
    db.exec(`update ${t} set ${col} = ${fill}`)
    db.exec('commit')
  } catch (e) { db.exec('rollback'); if (!/duplicate column/.test(String(e))) throw e }
}
// the setup checklist's last tick: the user's first uploaded notes (a column, since notes expire). Filled once, as it is
// added: users from before the checklist who had used a token or uploaded notes count as set up, like the old token bar did
db.exec('begin')
try {
  db.exec('alter table users add column notes_at text')
  db.exec(`update users set agent_at = created_at, extension_at = created_at, notes_at = created_at
    where id in (select user_id from tokens where last_used_at is not null union select user_id from annotations)`)
  db.exec('commit')
} catch (e) { db.exec('rollback'); if (!/duplicate column/.test(String(e))) throw e }

export const now =() => new Date().toISOString()
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const daysFromNow = (d: number) => new Date(Date.now() + d * 86400_000).toISOString()

export type User = { id: string; email: string; name: string; admin: number }

export function hashPassword(password: string) {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  if (!hash) return false // signed up with GitHub, no password set
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
    // EEXIST: the other one won. Anything else (a volume without hard links): rename, atomic too, last one wins
    try { fs.linkSync(tmp, file) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') fs.renameSync(tmp, file) } finally { fs.rmSync(tmp, { force: true }) }
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

// password '' = none (signed up with GitHub): only GitHub signs them in until they set one on Settings
export function createUser(email: string, password: string, name = '', admin = 0) {
  const id = randomUUID()
  db.prepare('insert into users (id, email, name, password, admin, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(id, email.trim(), name.trim(), password ? hashPassword(password) : '', admin, now())
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
  const token = `dn_${randomBytes(24).toString('base64url')}`
  db.prepare('insert into tokens (id, user_id, name, hash, created_at) values (?, ?, ?, ?, ?)')
    .run(randomUUID(), userId, name, sha256(token), now())
  return token
}


// Expired pull requests and stale invites/sessions; returns the expired pull ids for the caller to drop with their files.
export function purgeExpired(keep = '') { // keep: the live demo's pull request (DEMO_PR), which never expires
  const ids = (db.prepare('select id from pulls where expires_at < ? and id != ?').all(now(), keep) as { id: string }[]).map((r) => r.id)
  db.prepare('delete from invites where expires_at < ?').run(now())
  db.prepare('delete from sessions where created_at < ?').run(daysFromNow(-30)) // same 30 days currentUser() accepts
  return ids
}

// Files written before the files table existed: one row per file found on disk, once (on later boots a file without a
// row is a leftover of an interrupted replace or delete, not an attachment)
if (!getSetting('files_migrated')) {
  // their author is the PR's uploader, like the rows the user_id column was filled for above
  const add = db.prepare(`insert or ignore into files (pull_id, name, type, size, backend, user_id) values (?1, ?2, ?3, ?4, 'disk', (select user_id from pulls where id = ?1))`)
  for (const pull of fs.readdirSync(UPLOADS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    if (!db.prepare('select 1 from pulls where id = ?').get(pull)) continue
    for (const f of fs.readdirSync(path.join(UPLOADS, pull), { withFileTypes: true }).filter((e) => e.isFile())) {
      const ext = path.extname(f.name).slice(1).toLowerCase()
      add.run(pull, f.name, EXT_TYPES[ext] ?? 'application/octet-stream', fs.statSync(path.join(UPLOADS, pull, f.name)).size)
    }
  }
  setSetting('files_migrated', true)
}

// A consistent copy of the database for volume backups: they archive DATA_DIR while the app runs, and a live WAL database
// copied file by file can come out torn. DATA_DIR/backup/diffnotes.db, rewritten every hour (written aside, then renamed).
export function snapshot() {
  const dir = path.join(DATA_DIR, 'backup'), tmp = path.join(dir, `.${randomUUID()}.db`) // PID is 1 in every container
  fs.mkdirSync(dir, { recursive: true })
  fs.rmSync(tmp, { force: true })
  // ponytail: synchronous, requests wait while it copies (well under a second at this size); a worker thread if it grows
  try {
    db.prepare('vacuum into ?').run(tmp)
    fs.renameSync(tmp, path.join(dir, 'diffnotes.db'))
    // the copy from before the rename is never rewritten: it would keep expired PRs past RETENTION_DAYS
    fs.rmSync(path.join(dir, 'reviews42.db'), { force: true })
  } finally { fs.rmSync(tmp, { force: true }) } // a failed copy (disk full) doesn't keep its partial file
}
