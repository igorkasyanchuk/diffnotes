import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { afterAll, expect, it } from 'vitest'

// CLOUDFLARE_ONLY over a real socket: loopback is a local proxy, so the last X-Forwarded-For entry is the peer
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-cf-'))
process.env.CLOUDFLARE_ONLY = '1'
const { app } = await import('./app.ts')
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
await new Promise((r) => server.once('listening', r))
afterAll(() => { server.close() })
const get = async (p: string, forwarded?: string) =>
  (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${p}`, { headers: forwarded ? { 'x-forwarded-for': forwarded } : {} })).status

it('answers Cloudflare only, and local health checks', async () => {
  expect(await get('/robots.txt', '203.0.113.9')).toBe(403)
  expect(await get('/robots.txt', '203.0.113.9, 104.16.0.1')).toBe(200)
  expect(await get('/robots.txt', '104.16.0.1, 203.0.113.9')).toBe(403)
  expect(await get('/robots.txt')).toBe(403)
  expect(await get('/healthz')).toBe(200)
  expect(await get('/healthz', '203.0.113.9')).toBe(403)
})
