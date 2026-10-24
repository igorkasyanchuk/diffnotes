import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Where uploaded files live: on disk under DATA_DIR/uploads (default) or in an S3-compatible bucket (AWS S3, R2, B2,
// MinIO…), chosen by a super admin in the server settings. Each file row remembers its backend, so switching keeps old
// files readable. Keys are `<prefix>pulls/<pull id>/<name>`; names are already reduced to [A-Za-z0-9._-].

// endpoint without a trailing slash, prefix '' or `a/b/`: PUT /api/admin/storage normalizes both before saving
export type S3Config = { endpoint: string; region: string; bucket: string; key_id: string; secret: string; prefix: string }

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

// AWS Signature V4 for one path-style request. query: already sorted `k=v&…` pairs with encoded values, or ''.
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

export async function s3(cfg: S3Config, method: string, key: string, body?: Buffer, extra: Record<string, string> = {}, query = '') {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}${query ? `?${query}` : ''}`)
  const payload = body ?? Buffer.alloc(0)
  const headers = sign(method, url, { 'x-amz-content-sha256': sha(payload), ...extra }, new Date(), cfg.key_id, cfg.secret, cfg.region || 'auto')
  delete (headers as Record<string, string>).host
  const res = await fetch(url, { method, headers, body: body && method !== 'GET' ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) })
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    // only the S3 error code, never the body: the endpoint is admin-set and could be any internal service
    const code = (await res.text()).match(/<Code>(\w{1,64})<\/Code>/)?.[1]
    throw new Error(`S3 ${method} ${res.status}${code ? `: ${code}` : ''}`)
  }
  return res
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

// Safety net besides the server's own purge: a bucket lifecycle rule that expires everything under the prefix a day
// after the retention period (every re-upload writes new objects, so their age restarts). Replaces the bucket's rules.
export async function applyLifecycle(cfg: S3Config, days: number) {
  const prefix = `${cfg.prefix}pulls/`
  const xml = `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration><Rule><ID>reviews42-expire</ID><Filter><Prefix>${prefix}</Prefix></Filter>` +
    `<Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration></Rule></LifecycleConfiguration>`
  const body = Buffer.from(xml)
  await s3(cfg, 'PUT', '', body, { 'content-md5': createHash('md5').update(body).digest('base64'), 'content-type': 'application/xml' }, 'lifecycle=')
}

// put, read back and delete one object: proves the endpoint, bucket and keys work before saving them
export async function checkS3(cfg: S3Config) {
  const key = `${cfg.prefix}reviews42-check-${Date.now()}.txt`
  await s3(cfg, 'PUT', key, Buffer.from('ok'), { 'content-type': 'text/plain' })
  const back = await (await s3(cfg, 'GET', key)).text()
  await s3(cfg, 'DELETE', key)
  if (back !== 'ok') throw new Error('S3 returned different content than was written')
}
