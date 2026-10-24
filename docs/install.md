# Install & configure

← [README](../README.md)

Reviews42 is one Node 24 process with a SQLite database and an uploads folder, shipped as one Docker image.

## Docker

```bash
git clone https://github.com/igorkasyanchuk/reviews42 && cd reviews42
docker build -t reviews42 .
docker run -d --name reviews42 -p 3000:3000 -v reviews42:/data \
  -e ADMIN_EMAIL=you@company.com \
  -e PUBLIC_URL=https://reviews.company.com \
  reviews42
```

- Keep `/data` on a persistent volume: it holds the database, uploads (when stored on disk) and the generated secrets.
- Put it behind HTTPS (Caddy, Traefik, Coolify, Cloudflare…) and set `PUBLIC_URL` to that `https://` origin: links for
  agents and the `Secure` cookie flag depend on it.
- Health check: `GET /healthz` (the image's `HEALTHCHECK` already calls it).

### Coolify

New resource → your Git repository → build pack **Dockerfile**, port `3000`, a volume at `/data`, environment
`PUBLIC_URL` and `ADMIN_EMAIL`, your domain. Pushing to the branch redeploys (about a minute).

## First admin

On the first start (no users yet) the server creates `ADMIN_EMAIL` with `ADMIN_PASSWORD`. Leave `ADMIN_PASSWORD` unset
and a random one is printed once:

```bash
docker logs reviews42 | grep "first admin"
```

Copy it right away: every redeploy starts a new container, so the line is gone after the next one. That user owns the
account “My team” and is a **super admin** (server page at `/admin`). Everyone else joins by invitation, see
[accounts](accounts.md).

Lost password:

```bash
docker exec -it reviews42 npm run reset-password                 # the first admin
docker exec -it reviews42 npm run reset-password -- dev@company.com
```

It prints a new random password and signs that user out everywhere; their agent tokens keep working.

## Environment

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` (`/data` in Docker) | database, uploads, `session.secret`, `encryption.key` |
| `PUBLIC_URL` | the request's origin | the public `https://` origin |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin` / random | only used when there are no users yet |
| `RETENTION_DAYS` | `30` | notes and files are deleted this long after the PR's last upload |
| `MAX_FILE_MB` / `MAX_PULL_MB` | `1` / `20` | per uploaded file / all files of one PR |
| `MAX_BODY_KB` | `1024` | JSON request bodies |
| `MAX_ACCOUNT_MB` / `MAX_PULLS` | `1024` / `1000` | per account: files of all its PRs / PRs with notes (expired ones don't count) |
| `SESSION_SECRET` | random, in `DATA_DIR` | signs session cookies |
| `ENCRYPTION_KEY` | random, in `DATA_DIR` | encrypts stored secrets (the S3 secret key) |
| `CLOUDFLARE_ONLY` | unset | `1` behind Cloudflare: only Cloudflare's addresses may connect (the server's own IP serves nothing) and `cf-connecting-ip` is trusted as the client |
| `BUGSINK_DSN` | unset | Sentry-compatible DSN (Bugsink, GlitchTip, Sentry); 500s are reported with the route pattern only |

File storage (disk or an S3-compatible bucket) is not an environment variable: a super admin sets it on `/admin`, see
[storage](storage.md).

## Upgrades and backups

- Upgrade: pull, rebuild, restart. The database migrates itself on start.
- Back up the whole `/data` volume (Coolify: the app's Backups → add the volume, daily, enable S3). With S3 storage,
  uploads live in the bucket; the volume still holds the database and the encryption key that unlocks the S3 secret.
  Archives taken while the app runs can catch the live database mid-write, so the app also writes a consistent copy
  every hour to `/data/backup/reviews42.db`: restore from that one.
- An hourly job deletes expired PRs, their files, old sessions and expired invitations.

## Local development

```bash
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me npm run dev   # API :3000, Vite :5173
npm test && npm run typecheck && npm run build
```

More in [AGENTS.md](../AGENTS.md).
