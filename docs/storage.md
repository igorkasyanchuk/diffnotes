# File storage

← [README](../README.md)

Screenshots and files uploaded with notes are stored **on disk** (`DATA_DIR/uploads`, the default) or in an
**S3-compatible bucket**, set in the server's environment: `STORAGE_TYPE` and that provider's variables. Not in the
web app: the keys never reach the database or its backups, and a stolen super admin session can't redirect uploads.
**Server admin → file storage** shows what is in use (never the secret) and sets the bucket's expiry rule.

- Each file remembers where it was written, so switching never breaks older files; new uploads go to the new place.
  Keep a bucket's variables while files are still stored in it (they expire with their PRs).
- Files are always served through the server (`/files/…`), with the same access check as their PR. The bucket stays private.
- Quotas and statistics come from the database, so they work the same for both.
- A missing or malformed variable stops the server at start, naming it. At start the server also writes, reads and
  deletes one object and logs `storage: b2 bucket diffnotes-files ok`, or what failed (wrong key, wrong region…).

## Providers

| `STORAGE_TYPE` | Variables | Where to get them |
|---|---|---|
| `disk` (default) | none | files in `DATA_DIR/uploads` |
| `b2` **Backblaze B2** | `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APPLICATION_KEY` | region: the part after `s3.` in the bucket's Endpoint (`us-west-004`); Application Keys → keyID + applicationKey |
| `r2` **Cloudflare R2** | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the account ID on R2's overview; R2 → Manage API tokens → Object Read & Write |
| `s3` **AWS S3** | `AWS_REGION`, `AWS_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | an IAM user with `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:PutLifecycleConfiguration` on the bucket |
| `minio` **MinIO** or any other S3-compatible service | `MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | the service URL (`https://minio.example.com`), path-style URLs |

`STORAGE_PREFIX` (optional, any provider): a folder inside the bucket, e.g. `diffnotes/`. Objects are written as
`<prefix>pulls/<pull id>/<file name>`, path-style, signed with AWS Signature V4.

### Backblaze B2, step by step

1. **Buckets → Create a Bucket**: a lowercase name (`diffnotes-files`), **Private**. Note its Endpoint, e.g.
   `s3.us-west-004.backblazeb2.com`.
2. **Lifecycle Settings → custom rules**: prefix `diffnotes/` (your `STORAGE_PREFIX`), days till hide `31`
   (`RETENTION_DAYS` + 1), days till delete `1`. B2 keeps old versions by default, so without a rule deletes only hide
   files. (No prefix: **Keep only the last version**.)
3. **Application Keys → Add a New Application Key**: access to this bucket only, **Read and Write**. Copy keyID and
   applicationKey (shown once).
4. In your host's environment (Coolify: the app's Environment Variables, the key as a secret):
   ```
   STORAGE_TYPE=b2
   B2_REGION=us-west-004
   B2_BUCKET=diffnotes-files
   B2_KEY_ID=<keyID>
   B2_APPLICATION_KEY=<applicationKey>
   STORAGE_PREFIX=diffnotes/
   ```
5. Redeploy and look for `storage: b2 bucket diffnotes-files ok` in the log.

### From a bucket saved on `/admin`

Older versions kept the bucket in the database. Without `STORAGE_TYPE` its files still read and delete, and new uploads
go to disk. To keep using it, set the same bucket, keys and prefix in the environment.

## Expiry

Files expire with their PR, `RETENTION_DAYS` (30) after its last upload:

1. **The server deletes them**: an hourly job removes expired PRs and deletes their files from disk or from the bucket.
   Re-uploading a PR replaces the uploader's files right away.
2. **A bucket rule as a safety net**: **set the expiry rule on the bucket** adds a lifecycle rule that deletes everything
   under the prefix after `RETENTION_DAYS + 1` days (each re-upload writes new objects, so their age restarts). It
   replaces the bucket's existing lifecycle rules: use a bucket only for DiffNotes. Where the provider doesn't accept
   rules over the S3 API (Backblaze B2), set it in the provider's console instead.
