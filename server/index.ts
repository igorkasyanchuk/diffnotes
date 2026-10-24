import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { db, purgeExpired } from './db.ts'

const port = Number(process.env.PORT ?? 3000)
purgeExpired()
const timer = setInterval(purgeExpired, 3600_000)
const server = serve({ fetch: app.fetch, port }, () => console.log(`reviews42 on :${port}`))
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0) }) })
