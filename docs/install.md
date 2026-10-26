# Install & configure

← [README](../README.md)

DiffNotes is one Node 24 process with a SQLite database and an uploads folder, shipped as one Docker image.

## Docker

```bash
git clone https://github.com/igorkasyanchuk/diffnotes && cd diffnotes
docker build -t diffnotes .
docker run -d --name diffnotes -p 3000:3000 -v diffnotes:/data \
  -e ADMIN_EMAIL=you@company.com \
  -e PUBLIC_URL=https://reviews.company.com \
  diffnotes
```

Or with Docker Compose: edit `PUBLIC_URL` and `ADMIN_EMAIL` in [`docker-compose.yml`](../docker-compose.yml) (every
other variable is listed there, commented out), then `docker compose up -d`.

- Keep `/data` on a persistent volume: it holds the database, uploads (when stored on disk) and the generated secrets.
- Put it behind HTTPS (Caddy, Traefik, Coolify, Cloudflare…) and set `PUBLIC_URL` to that `https://` origin: links for
  agents and the `Secure` cookie flag depend on it.
- Health check: `GET /healthz` (the image's `HEALTHCHECK` already calls it). With `CLOUDFLARE_ONLY=1` it answers only
  local callers (the container itself, the proxy), so monitor the public URL instead.
- The app runs as the image's unprivileged `node` user. The container starts as root only to give `/data` to `node`
  (volumes from images before 1.0 are root-owned), then drops root.

Coolify, Render, Fly.io, Railway: [deploy](deploy.md).

## One instance only

DiffNotes runs as **exactly one instance**: the database is a SQLite file in `/data`, and login throttling counts
failures in that process's memory. A second copy with its own volume is a different, empty server; a second copy
sharing the volume doubles the throttle budgets and the hourly jobs, and on a network volume (NFS, EFS, SMB) SQLite's
locking is not reliable and the database can be corrupted. So:

- one container, one local (block) volume; no replicas, no autoscaling;
- deploys may overlap old and new for a few seconds on the same local volume (Coolify's rolling update does this):
  SQLite locks across processes on a local disk, so that is safe. A stop-then-start deploy is fine too: the extension
  and the skill simply try again;
- scale up, not out: one small instance serves many teams (a request is a few SQLite reads); give it more CPU or
  memory if needed;
- high availability means fast recovery, not failover: a restart policy (`unless-stopped`, the platform's health
  check) and backups you have restored once (below).

## First admin

On the first start (no users yet) the server creates `ADMIN_EMAIL` with `ADMIN_PASSWORD`. Leave `ADMIN_PASSWORD` unset
and a random one is printed once:

```bash
docker logs diffnotes | grep "first admin"
```

Copy it right away: every redeploy starts a new container, so the line is gone after the next one. That user owns the
account “My team” and is a **super admin** (server page at `/admin`). Everyone else joins by invitation, see
[accounts](accounts.md).

Lost password:

```bash
docker exec -u node -it diffnotes npm run reset-password                 # the first admin
docker exec -u node -it diffnotes npm run reset-password -- dev@company.com
```

`-u node` runs it as the app's user. A platform's web terminal that runs as root works too: the database files keep
their owner, and the next start gives `node` anything root left in `/data`.

It prints a new random password and signs that user out everywhere; their agent tokens keep working.

## Environment

This table is the one reference for configuration: everything is an environment variable with a default.
[`docker-compose.yml`](../docker-compose.yml) and the [deploy templates](deploy.md) list them all.

| Variable | Default | |
|---|---|---|
| **Server** | | |
| `PUBLIC_URL` | the request's origin | the public `https://` origin |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin` / random | only used when there are no users yet |
| `RETENTION_DAYS` | `30` | notes and files are deleted this long after the PR's last upload |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` (`/data` in Docker) | database, uploads, `session.secret`, `encryption.key` |
| **Limits** | | |
| `MAX_FILE_MB` | `1` | per uploaded file |
| `MAX_VIDEO_MB` | `2` | per uploaded `.mp4` / `.webm` screen recording (instead of `MAX_FILE_MB`) |
| `MAX_FILES` | `30` | files per PR (one upload) |
| `MAX_PULL_MB` | `20` | all files of one PR |
| `MAX_ANNOTATIONS` | `500` | notes per PR |
| `MAX_BODY_KB` | `1024` | JSON request bodies |
| `MAX_ACCOUNT_MB` / `MAX_PULLS` | `1024` / `1000` | per account: files of all its PRs / PRs with notes (expired ones don't count) |
| `MAX_ACCOUNTS` | `10` | accounts one user may own (with `ALLOW_SIGNUP=1`, each one is more quota) |
| `MIN_FREE_DISK_MB` | `100` | uploads to disk storage get `507` once the volume would have less free space |
| **Security** | | |
| `SESSION_SECRET` | random, in `DATA_DIR` | signs session cookies |
| `ENCRYPTION_KEY` | random, in `DATA_DIR` | encrypts stored secrets (only an S3 secret key saved on `/admin` before storage moved to the environment) |
| `CLOUDFLARE_ONLY` | unset | `1` behind Cloudflare: only Cloudflare's addresses may connect (the server's own IP serves nothing). Not with Cloudflare Tunnel, which already hides it |
| **Integrations** (off unless you set them; nothing is preset) | | |
| `BUGSINK_DSN` | unset | your own Sentry-compatible DSN (Bugsink, GlitchTip, Sentry); 500s are reported with the route pattern only |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | a GitHub OAuth app: **sign in with GitHub** ([accounts](accounts.md#sign-in-with-github)); callback `<PUBLIC_URL>/auth/github/callback` |
| `DEMO_PR` | unset | `owner/name#12` or the PR's URL: a live demo for visitors. That PR's notes, as a super admin uploaded them, are readable by every signed-in user and never expire; `/demo` explains the steps |
| `ALLOW_SIGNUP` | unset | `1` with GitHub sign-in: anyone with a GitHub account may sign up and gets a team account of their own |
| **File storage** ([storage](storage.md)) | | |
| `STORAGE_TYPE` | `disk` | `disk` (`DATA_DIR/uploads`), `b2` (Backblaze B2), `r2` (Cloudflare R2), `s3` (AWS S3) or `minio` (MinIO or any other S3-compatible service) |
| `B2_REGION` / `B2_BUCKET` / `B2_KEY_ID` / `B2_APPLICATION_KEY` | unset | with `b2`: the part after `s3.` in the bucket's Endpoint (`us-west-004`), the bucket, an application key's keyID and applicationKey |
| `R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | unset | with `r2`: the Cloudflare account ID, the bucket, an R2 API token's access key ID and secret |
| `AWS_REGION` / `AWS_BUCKET` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | unset | with `s3`: the bucket's region, the bucket, an IAM user's keys |
| `MINIO_ENDPOINT` / `MINIO_BUCKET` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | unset | with `minio`: the service URL (`https://minio.example.com`), the bucket, the keys |
| `STORAGE_PREFIX` | unset | a folder inside the bucket, e.g. `diffnotes/` |
| **Other** | | |
| `UMAMI_SCRIPT` / `UMAMI_WEBSITE_ID` | unset | your own Umami on the landing page only (e.g. `https://umami.example.com/script.js` and the website id): one page view, never the app's pages |

A missing or malformed storage variable stops the server at start with the variable's name; at start it also writes,
reads and deletes one object in the bucket and logs `storage: … ok` or what failed.

## Upgrades and backups

- Upgrade: pull, rebuild, restart. The database migrates itself on start. What changed: [CHANGELOG](../CHANGELOG.md).
- Back up the whole `/data` volume (Coolify: the app's Backups → add the volume, daily, enable S3). With S3 storage,
  uploads live in the bucket (its keys live in the environment); the volume still holds the database.
  Archives taken while the app runs can catch the live database mid-write, so the app also writes a consistent copy
  every hour to `/data/backup/diffnotes.db`: restore from that one. Without volume backups, copy it out yourself, e.g.
  daily `docker cp diffnotes:/data/backup/diffnotes.db diffnotes-$(date +%F).db`, plus `encryption.key` once.
- Restore: stop the app, put the volume back (or only the database: copy `backup/diffnotes.db` over `diffnotes.db` and
  delete `diffnotes.db-wal` and `diffnotes.db-shm`, or SQLite replays the archive's stale log into it), keep `encryption.key` and `session.secret` (or set the same
  `ENCRYPTION_KEY` / `SESSION_SECRET`), start it. Without the old `session.secret` everyone signs in again; without
  the encryption key, a bucket saved on `/admin` before storage moved to the environment can't be read: set it in the environment. Agent tokens survive either way.
- An hourly job deletes expired PRs, their files, old sessions and expired invitations.

## Local development

```bash
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me npm run dev   # API :3000, Vite :5173
npm test && npm run typecheck && npm run build
```

More in [AGENTS.md](../AGENTS.md).

## Releases

One version for the server, the web app and the extension:

1. `npm version X.Y.Z --no-git-tag-version` (`package.json` and `package-lock.json`) and the same `version` in
   `extension/manifest.json`.
2. Move *Unreleased* in [CHANGELOG.md](../CHANGELOG.md) to a new `X.Y.Z` section with the date.
3. Commit, tag `vX.Y.Z`, push the tag. The version shows in the web app's footer and on `/admin`.
