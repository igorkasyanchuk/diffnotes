import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Where uploaded files live: on disk under DATA_DIR/uploads (default) or in an S3-compatible bucket (AWS S3, R2, B2,
// MinIO…) set by STORAGE_TYPE and its provider's environment variables. Each file row remembers its backend, so moving from disk
// to a bucket keeps old files readable (not back: without STORAGE_TYPE there are no keys for the bucket). Keys are `<prefix>pulls/<pull id>/<name>`; names are already reduced to [A-Za-z0-9._-].

// endpoint without a trailing slash, prefix '' or `a/b/`: s3FromEnv() normalizes both
export type S3Config = { endpoint: string; region: string; bucket: string; key_id: string; secret: string; prefix: string }

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

// AWS Signature V4 for one path-style request; its query (if any) comes from url.searchParams.
export function sign(method: string, url: URL, headers: Record<string, string>, date: Date, keyId: string, secret: string, region: string, service = 's3') {
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`
  const h: Record<string, string> = { host: url.host, 'x-amz-date': amzDate }
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v.trim()
  const names = Object.keys(h).sort()
  const query = [...url.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join('&')
  const canonical = [method, url.pathname, query, ...names.map((n) => `${n}:${h[n]}`), '', names.join(';'), h['x-amz-content-sha256']].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n')
  let key: Buffer | string = `AWS4${secret}`
  for (const part of scope.split('/')) key = createHmac('sha256', key).update(part).digest()
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }
}

// A 5xx (but 501, which is for good), a 429 or a dropped connection is tried again, 3 tries in all: B2 and S3 answer a
// busy node with 500 / 503, R2 a key written again within a second with 429, and ask clients to retry (production saw a
// B2 `500 InternalError` on one PUT of three).
// A timeout isn't: a bucket that hangs fails after 30 s, not 90.
export async function s3(cfg: S3Config, method: string, key: string, body?: Buffer, extra: Record<string, string> = {}) {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}`)
  const hash = sha(body ?? Buffer.alloc(0)), bytes = body && method !== 'GET' ? new Uint8Array(body) : undefined
  let res: Response | null
  for (let attempt = 1; ; attempt++) {
    const headers = sign(method, url, { 'x-amz-content-sha256': hash, ...extra }, new Date(), cfg.key_id, cfg.secret, cfg.region || 'auto')
    delete (headers as Record<string, string>).host
    const last = attempt === 3
    res = await fetch(url, { method, headers, body: bytes, signal: AbortSignal.timeout(30_000) }).catch((e) => { if (last || e?.name === 'TimeoutError') throw e; return null })
    if (res && (last || (res.status < 500 && res.status !== 429) || res.status === 501)) break
    try { await res?.body?.cancel() } catch {} // a body that broke off rejects its cancel
    await sleep(250 * (attempt + 1))
  }
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    // only the S3 error code, never the body: the endpoint is admin-set and could be any internal service
    const code = (await res.text()).match(/<Code>(\w{1,64})<\/Code>/)?.[1]
    throw new Error(`S3 ${method} ${res.status}${code ? `: ${code}` : ''}`)
  }
  return res
}

// STORAGE_TYPE picks where files go: disk (default), b2, r2, s3 (AWS) or minio (also any other S3-compatible service),
// each with its provider's own variables (named as its console names them), plus STORAGE_PREFIX for a folder in the bucket.
// In the environment, not the database: the secret never lands in the database or its backups, and a stolen super admin
// session can't point uploads at another bucket. A missing or malformed value throws, so it fails the boot, not an upload.
const REGION = /^[a-z0-9-]{2,40}$/
type Provider = { vars: Record<'bucket' | 'key_id' | 'secret' | 'place', string>; endpoint: (place: string) => string; region: (place: string) => string; place: RegExp; hint: string }
export const PROVIDERS: Record<string, Provider> = {
  b2: { vars: { place: 'B2_REGION', bucket: 'B2_BUCKET', key_id: 'B2_KEY_ID', secret: 'B2_APPLICATION_KEY' },
    endpoint: (r) => `https://s3.${r}.backblazeb2.com`, region: (r) => r, place: REGION, hint: 'the part after "s3." in the bucket\'s Endpoint, e.g. us-west-004' },
  r2: { vars: { place: 'R2_ACCOUNT_ID', bucket: 'R2_BUCKET', key_id: 'R2_ACCESS_KEY_ID', secret: 'R2_SECRET_ACCESS_KEY' },
    endpoint: (id) => `https://${id}.r2.cloudflarestorage.com`, region: () => 'auto', place: /^[a-f0-9]{32}$/, hint: 'the 32-character account ID' },
  s3: { vars: { place: 'AWS_REGION', bucket: 'AWS_BUCKET', key_id: 'AWS_ACCESS_KEY_ID', secret: 'AWS_SECRET_ACCESS_KEY' },
    endpoint: (r) => `https://s3.${r}.amazonaws.com`, region: (r) => r, place: REGION, hint: 'the bucket\'s region, e.g. eu-central-1' },
  minio: { vars: { place: 'MINIO_ENDPOINT', bucket: 'MINIO_BUCKET', key_id: 'MINIO_ACCESS_KEY', secret: 'MINIO_SECRET_KEY' },
    endpoint: (u) => u.replace(/\/+$/, ''), region: () => 'us-east-1', place: /^https?:\/\/[\w.-]+(:\d+)?\/*$/, hint: 'the service URL, e.g. https://minio.example.com' },
}
// ponytail: list prices (USD per GB-month, standard storage, the free GB per bucket) hard-coded as of PRICES_AS_OF, for
// /admin's cost estimate only; egress and API calls left out (B2 and R2 serve these small files free). Re-check them
// now and then, or read them from env vars if they drift. disk and minio: your own hardware, no price
export const PRICES_AS_OF = '2026-10-27'
export const PRICES: Record<string, { name: string; gb_month: number; free_gb: number }> = {
  b2: { name: 'Backblaze B2', gb_month: 0.00695, free_gb: 10 },
  r2: { name: 'Cloudflare R2', gb_month: 0.015, free_gb: 10 },
  s3: { name: 'AWS S3 Standard (us-east-1)', gb_month: 0.023, free_gb: 0 },
}

export const storageType = (env: Record<string, string | undefined>) => (env.STORAGE_TYPE ?? '').trim().toLowerCase() || 'disk'
export function s3FromEnv(env: Record<string, string | undefined>): S3Config | null {
  const type = storageType(env)
  if (type === 'disk') return null
  const p = PROVIDERS[type]
  if (!p) throw new Error(`STORAGE_TYPE is disk, ${Object.keys(PROVIDERS).join(', ')}; not ${type}`)
  const v = (k: string) => (env[k] ?? '').trim()
  const missing = Object.values(p.vars).filter((k) => !v(k))
  if (missing.length) throw new Error(`STORAGE_TYPE=${type} needs ${missing.join(', ')}`)
  const place = v(p.vars.place), bucket = v(p.vars.bucket), prefix = v('STORAGE_PREFIX').replace(/^\/+/, '').replace(/([^/])$/, '$1/')
  if (!p.place.test(place)) throw new Error(`${p.vars.place}: ${p.hint}`)
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error(`${p.vars.bucket}: 3-63 lowercase letters, digits, dots and dashes`)
  // the prefix goes into URLs: `#`, `?` or `..` would point every key somewhere else
  if (!/^([\w-][\w.-]*\/)*$/.test(prefix)) throw new Error('STORAGE_PREFIX: folders of letters, digits, dots, dashes and underscores, e.g. diffnotes/')
  return { endpoint: p.endpoint(place), region: p.region(place), bucket, key_id: v(p.vars.key_id), secret: v(p.vars.secret), prefix }
}

const objectKey = (cfg: S3Config, pull: string, name: string) => `${cfg.prefix}pulls/${pull}/${name}`

// config: the bucket's credentials (kept for reading and deleting older files); useS3: whether new uploads go there
export function storage(uploads: string, config: () => S3Config | null, useS3: () => boolean) {
  const dir = (pull: string) => path.join(uploads, pull)
  return {
    // which backend new uploads go to
    current: () => (useS3() ? 's3' : 'disk') as 'disk' | 's3',
    async put(backend: string, pull: string, name: string, data: Buffer, type: string) {
      if (backend === 's3') { const cfg = need(config()); return void await s3(cfg, 'PUT', objectKey(cfg, pull, name), data, { 'content-type': type }) }
      fs.mkdirSync(dir(pull), { recursive: true })
      fs.writeFileSync(path.join(dir(pull), name), data)
    },
    async get(backend: string, pull: string, name: string): Promise<Buffer | null> {
      if (backend === 's3') {
        const cfg = config()
        if (!cfg) return null
        const res = await s3(cfg, 'GET', objectKey(cfg, pull, name)).catch(() => null)
        return res ? Buffer.from(await res.arrayBuffer()) : null
      }
      const file = path.join(dir(pull), name)
      return fs.existsSync(file) ? fs.readFileSync(file) : null
    },
    // ponytail: one DELETE per object, 20 at a time (an account delete can hold thousands); DeleteObjects if that gets slow
    async remove(files: { backend: string; pull: string; name: string }[]) {
      const cfg = files.some((f) => f.backend === 's3') ? config() : null
      const drop = async (f: { backend: string; pull: string; name: string }) => {
        if (f.backend === 's3') { if (cfg) await s3(cfg, 'DELETE', objectKey(cfg, f.pull, f.name)).catch(() => {}) }
        else fs.rmSync(path.join(dir(f.pull), f.name), { force: true })
      }
      for (let i = 0; i < files.length; i += 20) await Promise.all(files.slice(i, i + 20).map(drop))
      for (const p of new Set(files.map((f) => f.pull))) {
        try { fs.rmdirSync(dir(p)) } catch {} // only when empty
      }
    },
  }
}
const need = (cfg: S3Config | null) => cfg ?? (() => { throw new Error('S3 storage is not configured') })()

// No bucket expiry rule by age: a file's age says nothing about its PR's (a teammate's upload extends the PR without
// rewriting your files, the live demo never expires). The hourly purge deletes files with their PR.

// put, read back and delete one object: proves the endpoint, bucket and keys work (logged at start)
export async function checkS3(cfg: S3Config) {
  const key = `${cfg.prefix}diffnotes-check-${Date.now()}.txt`
  await s3(cfg, 'PUT', key, Buffer.from('ok'), { 'content-type': 'text/plain' })
  const back = await (await s3(cfg, 'GET', key)).text()
  await s3(cfg, 'DELETE', key)
  if (back !== 'ok') throw new Error('S3 returned different content than was written')
}
