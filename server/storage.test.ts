import http from 'node:http'
import { expect, test } from 'vitest'
import { checkS3, sign } from './storage.ts'

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
  await checkS3({ endpoint: `http://127.0.0.1:${port}`, region: 'auto', bucket: 'b', key_id: 'k', secret: 's', prefix: 'r42/' })
  server.close()
  expect(seen.map((s) => s.replace(/check-\d+/, 'check-N'))).toEqual([
    'PUT /b/r42/reviews42-check-N.txt signed', 'GET /b/r42/reviews42-check-N.txt signed', 'DELETE /b/r42/reviews42-check-N.txt signed'])
  expect(objects.size).toBe(0)
})
