import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, hashPassword } from './db.ts'

// Lost password: `npm run reset-password [-- email]` on the server (e.g. in the container) gives that user,
// by default the first admin, a new random password and prints it. The user's sessions end; agent tokens keep working.
export function resetPassword(email?: string) {
  const user = (email
    ? db.prepare('select id, email from users where email = ?').get(email.trim())
    : db.prepare('select id, email from users where admin = 1 order by created_at limit 1').get()) as { id: string; email: string } | undefined
  if (!user) {
    const all = (db.prepare('select email from users order by created_at').all() as { email: string }[]).map((u) => u.email)
    throw new Error(`No such user. Users: ${all.join(', ') || 'none'}`)
  }
  const password = randomBytes(12).toString('base64url')
  db.prepare('update users set password = ? where id = ?').run(hashPassword(password), user.id)
  db.prepare('delete from sessions where user_id = ?').run(user.id)
  return { email: user.email, password }
}

// realpath: the module URL is symlink-resolved, argv[1] is not
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false } })()
if (isMain) {
  try {
    const { email, password } = resetPassword(process.argv[2])
    console.log(`New password for "${email}": ${password}`)
  } catch (e) {
    console.error((e as Error).message)
    process.exitCode = 1
  }
}
