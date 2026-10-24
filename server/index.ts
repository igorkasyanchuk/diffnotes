import { serve } from '@hono/node-server'
import { app, purge } from './app.ts'
import { db } from './db.ts'

const port = Number(process.env.PORT ?? 3000)
const run = () => purge().catch((e) => console.error('purge failed', e))
run()
const timer = setInterval(run, 3600_000)
const server = serve({ fetch: app.fetch, port }, () => console.log(`reviews42 on :${port}, error reporting ${URL.parse(process.env.BUGSINK_DSN ?? '') ? 'on' : 'off'}`))
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0) }) })
