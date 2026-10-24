import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { app, purge } from './app.ts'
import { DATA_DIR, db } from './db.ts'

const port = Number(process.env.PORT ?? 3000)
// A consistent copy of the database for volume backups: they archive DATA_DIR while the app runs, and a live WAL database
// copied file by file can come out torn. DATA_DIR/backup/reviews42.db, rewritten every hour (written aside, then renamed).
function snapshot() {
  const dir = path.join(DATA_DIR, 'backup'), tmp = path.join(dir, `.${randomUUID()}.db`) // PID is 1 in every container
  fs.mkdirSync(dir, { recursive: true })
  fs.rmSync(tmp, { force: true })
  // ponytail: synchronous, requests wait while it copies (well under a second at this size); a worker thread if it grows
  try {
    db.prepare('vacuum into ?').run(tmp)
    fs.renameSync(tmp, path.join(dir, 'reviews42.db'))
  } finally { fs.rmSync(tmp, { force: true }) } // a failed copy (disk full) doesn't keep its partial file
}
// purge first: its database deletes run before its first await, so the copy never holds expired notes
const run = () => {
  purge().catch((e) => console.error('purge failed', e))
  try { snapshot() } catch (e) { console.error('snapshot failed', e) }
}
run()
const timer = setInterval(run, 3600_000)
const server = serve({ fetch: app.fetch, port }, () => console.log(`reviews42 on :${port}, error reporting ${URL.parse(process.env.BUGSINK_DSN ?? '') ? 'on' : 'off'}`))
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0) }) })
