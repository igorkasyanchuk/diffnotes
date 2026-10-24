# Reviews42

Your coding agent explains its pull request; your team reads the notes right on GitHub.

Three parts, one repo:

| Part | Where | What it does |
|---|---|---|
| Web app + API | `server/`, `web/` | Accounts (teams), members by invitation, repositories, tokens, annotated PRs. Annotations expire after `RETENTION_DAYS`. |
| Agent skill | `skill/reviews42/SKILL.md` | Teaches Claude Code, Codex, Cursor and other Agent Skills tools to upload per-file and per-line notes, screenshots and files for a PR. |
| Chrome extension | `extension/` | Connect one or more servers with a token each; on a PR's changes view it draws their notes next to the diff (expand, collapse, image preview) with a summary box above the files. |

Self-hosted. Licensed under [FSL-1.1-ALv2](LICENSE.md): free to use, modify and self-host, also commercially;
you may not offer it as a competing product or service. Each release becomes Apache-2.0 two years after it ships.

## Run it

```bash
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me npm run dev   # API :3000, Vite :5173
npm test && npm run typecheck && npm run build
```

Docker:

```bash
docker build -t reviews42 .
docker run -p 3000:3000 -v reviews42-data:/data -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD=change-me \
  -e PUBLIC_URL=https://reviews42.example.com reviews42
```

On first boot (no users) the server creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (a random password is
printed when unset) with an account "My team". Everyone else joins through an invitation link an account owner makes.

Lost password: `npm run reset-password [-- email]` on the server (in the container) prints a new random password for
that user, by default the first admin, and signs them out everywhere.

| Env | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | SQLite DB, uploads, session secret |
| `PUBLIC_URL` | request origin | `https://…` origin behind a proxy (links, `Secure` cookie) |
| `RETENTION_DAYS` | `30` | annotations live this long after their last upload |
| `MAX_FILE_MB` / `MAX_PULL_MB` | `10` / `50` | per uploaded file / per pull request |
| `SESSION_SECRET` | random, in `DATA_DIR` | cookie signing key |
| `BUGSINK_DSN` | unset | Sentry-compatible DSN (Bugsink, GlitchTip, Sentry): server 500s are reported with the route pattern only |

## Use it

1. **Skill:** `curl -fsSL https://<your server>/install.sh | sh`, make a token on `/settings`, then
   `export REVIEWS42_URL=https://<your server> REVIEWS42_TOKEN=r42_…`. Ask your agent: "annotate this PR with reviews42".
2. **Extension:** `chrome://extensions` → Developer mode → Load unpacked → pick `extension/`. In its popup enter the
   server and a token, press Connect (Chrome asks to allow that server's origin).
3. Open the PR's **Files changed** on GitHub. Members of the account that owns the repository see the notes.

## API (token: `authorization: Bearer r42_…`)

| Method | Path | |
|---|---|---|
| `PUT` | `/api/v1/pulls/:owner/:repo/:number` | replace a PR's notes: JSON `{title?, head_sha?, summary?, annotations: [{path, line?, end_line?, side?: RIGHT\|LEFT, title?, body}]}`, or multipart `payload` (JSON) + `file` fields; `attachment:<name>` in Markdown links an uploaded file |
| `GET` | `/api/v1/pulls/:owner/:repo/:number` | the notes (404 when none or not your account's) |
| `DELETE` | `/api/v1/pulls/:owner/:repo/:number` | remove them now |
| `GET` | `/api/v1/me` | who the token belongs to |
| `GET` | `/files/:pull/:name` | an uploaded file (same access as its PR) |

An unknown repository is connected to the uploader's account on its first upload.
