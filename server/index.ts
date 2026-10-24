// startup wiring only (excluded from coverage): the work lives in app.ts and db.ts, which the tests cover
import { serve } from '@hono/node-server'
import { app, purge } from './app.ts'
import { db, snapshot } from './db.ts'

const port = Number(process.env.PORT ?? 3000)
// purge first: its database deletes run before its first await, so the copy never holds expired notes
const run = () => {
  purge().catch((e) => console.error('purge failed', e))
  try { snapshot() } catch (e) { console.error('snapshot failed', e) }
}
run()
const timer = setInterval(run, 3600_000)
const server = serve({ fetch: app.fetch, port }, () => console.log(`reviews42 on :${port}, error reporting ${URL.parse(process.env.BUGSINK_DSN ?? '') ? 'on' : 'off'}`))
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0) }) })
