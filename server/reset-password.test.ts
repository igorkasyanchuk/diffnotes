import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-reset-'))
const { createUser, db, verifyPassword } = await import('./db.ts')
const { resetPassword } = await import('./reset-password.ts')

test('resets the first admin by default, or a named user; unknown email lists users', () => {
  expect(() => resetPassword()).toThrow('No such user. Users: none')
  const admin = createUser('admin@example.com', 'old-password', 'Admin', 1)
  createUser('dev@example.com', 'old-password')
  db.prepare('insert into sessions (id, user_id, created_at) values (?, ?, ?)').run('s1', admin, new Date().toISOString())
  const a = resetPassword()
  expect(a.email).toBe('admin@example.com')
  const row = db.prepare('select password from users where id = ?').get(admin) as { password: string }
  expect(verifyPassword(a.password, row.password)).toBe(true)
  expect(db.prepare('select 1 from sessions where user_id = ?').get(admin)).toBeUndefined()
  expect(resetPassword('DEV@example.com').email).toBe('dev@example.com')
  expect(() => resetPassword('nobody@example.com')).toThrow('Users: admin@example.com, dev@example.com')
})
