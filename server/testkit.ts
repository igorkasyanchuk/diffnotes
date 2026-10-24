import { expect } from 'vitest'
import type { Hono } from 'hono'

// a real PNG signature plus padding up to n bytes
export const png = (n = 16) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b }

export type Opts = { cookie?: string; token?: string; body?: unknown; form?: FormData; method?: string; headers?: Record<string, string> }
// requests straight into the app; JSON replies come back parsed
export function client(app: Hono<any>) {
  async function call(url: string, { cookie, token, body, form, method, headers: extra }: Opts = {}) {
    const headers: Record<string, string> = { ...extra }
    if (cookie) headers.cookie = cookie
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await app.request(url, { method: method ?? (body || form ? 'POST' : 'GET'), headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) })
    return { status: res.status, res, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
  }
  const login = async (email: string, password: string) => {
    const r = await call('/api/login', { body: { email, password } })
    expect(r.status).toBe(200)
    return r.res.headers.get('set-cookie')!.split(';')[0]
  }
  return { call, login }
}
