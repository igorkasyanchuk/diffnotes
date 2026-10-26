import http from 'node:http'
import { expect, test } from 'vitest'
import { checkS3, s3FromEnv, sign, storage } from './storage.ts'

// the "GET Object" example from AWS's Signature V4 docs for S3
test('signs like the AWS documentation example', () => {
  const h = sign('GET', new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    new Date('2013-05-24T00:00:00Z'), 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'us-east-1')
  expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
})

test('checks a bucket by writing, reading and deleting one object', async () => {
  const seen: string[] = [], objects = new Map<string, Buffer>()
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ? 'signed' : 'unsigned'}`)
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      if (req.method === 'PUT') objects.set(req.url!, Buffer.concat(chunks))
      if (req.method === 'DELETE') objects.delete(req.url!)
      res.end(req.method === 'GET' ? objects.get(req.url!) : '')
    })
  }).listen(0)
  const port = (server.address() as { port: number }).port
  await checkS3({ endpoint: `http://127.0.0.1:${port}`, region: 'auto', bucket: 'b', key_id: 'k', secret: 's', prefix: 'dn/' })
  server.close()
  expect(seen.map((s) => s.replace(/check-\d+/, 'check-N'))).toEqual([
    'PUT /b/dn/diffnotes-check-N.txt signed', 'GET /b/dn/diffnotes-check-N.txt signed', 'DELETE /b/dn/diffnotes-check-N.txt signed'])
  expect(objects.size).toBe(0)
})

test('reports only the S3 error code, and catches a bucket that returns other bytes', async () => {
  const server = http.createServer((req, res) => {
    req.resume().on('end', () => {
      if (req.url!.includes('denied')) { res.statusCode = 403; return res.end('<Error><Code>AccessDenied</Code><Message>secret</Message></Error>') }
      res.end(req.method === 'GET' ? 'not ok' : '')
    })
  }).listen(0)
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const cfg = { endpoint, region: '', bucket: 'b', key_id: 'k', secret: 's', prefix: '' }
  await expect(checkS3({ ...cfg, prefix: 'denied/' })).rejects.toThrow(/^S3 PUT 403: AccessDenied$/)
  await expect(checkS3(cfg)).rejects.toThrow('different content')
  server.close()
})

test('s3 files without a configured bucket read as missing and refuse writes', async () => {
  const store = storage('/nonexistent', () => null, () => true)
  expect(store.current()).toBe('s3')
  expect(await store.get('s3', 'p', 'a.png')).toBeNull()
  await expect(store.put('s3', 'p', 'a.png', Buffer.from('x'), 'image/png')).rejects.toThrow('not configured')
})

test('reads the bucket from STORAGE_TYPE and its provider\'s variables, and refuses a half-set or malformed one', () => {
  expect(s3FromEnv({})).toBeNull()
  expect(s3FromEnv({ STORAGE_TYPE: 'disk', B2_BUCKET: 'ignored' })).toBeNull()
  const keys = { bucket: 'dn-files', key_id: 'K', secret: 'S' }
  expect(s3FromEnv({ STORAGE_TYPE: 'B2', B2_REGION: 'us-west-004', B2_BUCKET: 'dn-files', B2_KEY_ID: 'K', B2_APPLICATION_KEY: 'S', STORAGE_PREFIX: '/dn' }))
    .toEqual({ endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', prefix: 'dn/', ...keys })
  expect(s3FromEnv({ STORAGE_TYPE: 'r2', R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET: 'dn-files', R2_ACCESS_KEY_ID: 'K', R2_SECRET_ACCESS_KEY: 'S' }))
    .toEqual({ endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, region: 'auto', prefix: '', ...keys })
  expect(s3FromEnv({ STORAGE_TYPE: 's3', AWS_REGION: 'eu-central-1', AWS_BUCKET: 'dn-files', AWS_ACCESS_KEY_ID: 'K', AWS_SECRET_ACCESS_KEY: 'S' }))
    .toMatchObject({ endpoint: 'https://s3.eu-central-1.amazonaws.com', region: 'eu-central-1' })
  const minio = { STORAGE_TYPE: 'minio', MINIO_ENDPOINT: 'https://minio.example.com/', MINIO_BUCKET: 'dn-files', MINIO_ACCESS_KEY: 'K', MINIO_SECRET_KEY: 'S' }
  expect(s3FromEnv(minio)).toMatchObject({ endpoint: 'https://minio.example.com', region: 'us-east-1' })
  expect(() => s3FromEnv({ STORAGE_TYPE: 'gcs' })).toThrow('STORAGE_TYPE is disk, b2, r2, s3, minio; not gcs')
  expect(() => s3FromEnv({ STORAGE_TYPE: 'b2', B2_BUCKET: 'x' })).toThrow('STORAGE_TYPE=b2 needs B2_REGION, B2_KEY_ID, B2_APPLICATION_KEY')
  expect(() => s3FromEnv({ ...minio, MINIO_ENDPOINT: 'ftp://x' })).toThrow(/^MINIO_ENDPOINT: the service URL/)
  expect(() => s3FromEnv({ ...minio, MINIO_BUCKET: 'Bad_Bucket' })).toThrow(/^MINIO_BUCKET: 3-63/)
  expect(() => s3FromEnv({ ...minio, STORAGE_PREFIX: 'a#b' })).toThrow(/^STORAGE_PREFIX/)
})
