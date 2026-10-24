import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

// a database and uploads folder from an older release: repositories unique server-wide, no risk column, files on disk without rows
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-old-'))
const old = new DatabaseSync(path.join(dir, 'reviews42.db'))
old.exec(`
  create table accounts (id text primary key, name text not null, created_at text not null);
  create table repositories (id text primary key, account_id text not null references accounts(id) on delete cascade,
    full_name text not null collate nocase unique, created_at text not null);
  create table pulls (id text primary key, repository_id text not null references repositories(id) on delete cascade,
    number integer not null, title text not null default '', head_sha text not null default '', summary text not null default '',
    user_id text, created_at text not null, updated_at text not null, expires_at text not null, unique (repository_id, number));
  create table annotations (id integer primary key autoincrement, pull_id text not null references pulls(id) on delete cascade,
    path text not null, line integer, end_line integer, side text not null default 'RIGHT',
    title text not null default '', body text not null default '', position integer not null default 0);
  insert into accounts values ('a', 'A', '2025-01-01');
  insert into repositories values ('r', 'a', 'o/n', '2025-01-01');
  insert into pulls (id, repository_id, number, created_at, updated_at, expires_at) values ('p', 'r', 1, '', '', '2999-01-01');`)
old.close()
fs.mkdirSync(path.join(dir, 'uploads/p'), { recursive: true })
fs.writeFileSync(path.join(dir, 'uploads/p/shot.png'), 'png!')
fs.writeFileSync(path.join(dir, 'uploads/p/notes.bin'), 'x')
fs.mkdirSync(path.join(dir, 'uploads/gone'))
process.env.DATA_DIR = dir
const { bootstrap, db, sessionSecret, snapshot } = await import('./db.ts')

it('migrates an older database', () => {
  const repos = (db.prepare("select sql from sqlite_master where name = 'repositories'").get() as { sql: string }).sql
  expect(repos).toContain('unique (account_id, full_name)')
  expect(db.prepare('select id from repositories').all()).toEqual([{ id: 'r' }])
  db.prepare("insert into annotations (pull_id, path, risk) values ('p', 'a.ts', 'high')").run()
  expect(db.prepare('select name, type, size from files order by name').all()).toEqual([
    { name: 'notes.bin', type: 'application/octet-stream', size: 1 }, { name: 'shot.png', type: 'image/png', size: 4 }])
})

it('prints a random first admin password once', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  bootstrap('first@example.com', '')
  bootstrap('second@example.com', '')
  expect(log).toHaveBeenCalledOnce()
  expect(log.mock.calls[0][0]).toMatch(/^first admin: first@example.com \/ \S+/)
})

it('writes a secret where hard links fail', () => {
  vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw Object.assign(new Error('no links'), { code: 'EPERM' }) })
  expect(sessionSecret()).toMatch(/^[0-9a-f]{64}$/)
  expect(sessionSecret()).toBe(fs.readFileSync(path.join(dir, 'session.secret'), 'utf8'))
})

it('snapshots the database for backups', () => {
  snapshot()
  const copy = new DatabaseSync(path.join(dir, 'backup/reviews42.db'))
  expect(copy.prepare('select count(*) as n from pulls').get()).toEqual({ n: 1 })
  copy.close()
  expect(fs.readdirSync(path.join(dir, 'backup'))).toEqual(['reviews42.db'])
})
