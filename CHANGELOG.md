# Changelog

All notable changes to DiffNotes (server, web app, browser extension and agent skill share one version).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `vX.Y.Z` ([how](docs/install.md#releases)).

## [1.0.0] - 2026-10-25

First tagged release; until now DiffNotes was known as Reviews42.

### Added

- **Notes in the diff** on GitHub pull requests, GitLab merge requests (gitlab.com) and Bitbucket
  pull requests: a summary box above the files, notes on the changed lines, a floating dock once you scroll, a notes
  on/off switch, show more / less, folds that stay folded after a reload until the note changes.
- **Attachments**: screenshots with a gallery, `.md` / `.csv` / `.txt` previews, and small interactive `.html` demos
  that run in a locked sandbox (opaque origin, no network) at phone, tablet or desktop width.
- **Risk map**: notes can mark a change low, medium or high risk, so reviewers know where to look hardest.
- **Before/after slider** for paired screenshots, opening large; **Mermaid diagrams** in notes.
- **Agent skill** for Claude Code, Codex, Cursor and other Agent Skills tools, installed with one `curl | sh`; it checks
  notes against the diff and refreshes or removes stale ones after new commits.
- **Accounts and roles**: owner, admin, member; invitation links; repositories per account; per-account access (other
  accounts get 404); a super admin page with users, accounts, uploads and disk.
- **Storage** on disk or in any S3-compatible bucket (Backblaze B2, Cloudflare R2, AWS S3, MinIO), with a bucket
  lifecycle rule as a safety net.
- **Retention**: notes and files expire `RETENTION_DAYS` (30) after a PR's last upload; quotas per account.
- **Backups**: an hourly consistent copy of the database in `/data/backup`.
- **Cloudflare-only mode** (`CLOUDFLARE_ONLY=1`): the origin answers only Cloudflare's addresses.
- **Error reporting** to your own Sentry-compatible DSN (`BUGSINK_DSN`: Bugsink, GlitchTip, Sentry), route pattern only.
- Optional **Umami** analytics on the landing page only (`UMAMI_SCRIPT`, `UMAMI_WEBSITE_ID`).
- `npm run reset-password` for a lost password.
- `docker-compose.yml`, deploy templates for Render (`render.yaml`) and Fly.io (`fly.toml`), and
  [deploy docs](docs/deploy.md) for Coolify and Railway.
- A privacy policy at `/privacy`; the version in the web app's footer and on `/admin`.
- **Changed since your last visit**: the extension tags notes that are new or rewritten since you last opened the PR.
- **Copy summary**: copy a PR's notes as a summary.
- The extension runs in **Firefox** (154+); Safari via Xcode's converter.
- **Screen recordings** (`.mp4`, `.webm`) that play in notes, up to `MAX_VIDEO_MB` (2 MB by default).
- An **MCP endpoint** (`/mcp`), so any MCP client can read, upload and delete notes with a token.
- Delete your own user (settings → danger zone), with the accounts you own.
- `MAX_FILES` and `MAX_ANNOTATIONS` limits.

### Changed

- Renamed from Reviews42 to DiffNotes (diffnotes.dev): the database file moves over on its own, `install.sh` replaces
  the old skill, and the skill reads `DIFFNOTES_URL` / `DIFFNOTES_TOKEN` (rename `REVIEWS42_*` in your shell profile).
- MIT license.
- The Docker image runs the app as the unprivileged `node` user; on start it gives an existing root-owned `/data` to it.
- Documented that DiffNotes runs as exactly one instance.
- The skill and the MCP tools forbid secrets and private data in notes, screenshots and recordings.
- Removing a repository is called **delete** and says what goes with it.

[1.0.0]: https://github.com/igorkasyanchuk/diffnotes/releases/tag/v1.0.0
