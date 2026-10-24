import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { app, purge } from './app.ts'
import { DATA_DIR, db } from './db.ts'

const port = Number(process.env.PORT ?? 3000)
// A consistent copy of the database for volume backups: they archive DATA_DIR while the app runs, and a live WAL database
// copied file by file can come out torn. DATA_DIR/backup/reviews42.db, rewritten every hour (written aside, then renamed).
function snapshot() {
  const dir = path.join(DATA_DIR, 'backup'), tmp = path.join(dir, `.${process.pid}.db`)
  fs.mkdirSync(dir, { recursive: true })
  fs.rmSync(tmp, { force: true })
  db.exec(`vacuum into '${tmp.replaceAll("'", "''")}'`)
  fs.renameSync(tmp, path.join(dir, 'reviews42.db'))
}
const run = () => {
  try { snapshot() } catch (e) { console.error('snapshot failed', e) }
  purge().catch((e) => console.error('purge failed', e))
}
run()
const timer = setInterval(run, 3600_000)
const server = serve({ fetch: app.fetch, port }, () => console.log(`reviews42 on :${port}, error reporting ${URL.parse(process.env.BUGSINK_DSN ?? '') ? 'on' : 'off'}`))
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0) }) })
