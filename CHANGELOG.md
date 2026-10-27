# Changelog

All notable changes to DiffNotes (server, web app, browser extension and agent skill share one version).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `vX.Y.Z` ([how](docs/install.md#releases)).

## [Unreleased]

### Added

- **Sign in with GitHub** (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`): existing users are found by their verified
  emails, invited people join without a password, and `ALLOW_SIGNUP=1` opens registration (a user and a team account
  of their own). Users made through GitHub can set a password later.
- **Install in the hero**: the one-command skill install with a copy button and *add to Chrome*, right under the headline.
- **Live demo** (`DEMO_PR=owner/name#12`): one pull request whose notes every signed-in user can read and that never
  expires, while its last upload and every note and file on it are by super admins; `/demo` walks a visitor through extension, account, token and the PR.
- **Invite by GitHub login**: an account admin invites `octocat` instead of an email; it waits until that login signs
  in with GitHub, then shows on their dashboard to join.
- **Extension: one-line connect**: Settings shows `{"server":…,"token":…}` for a new token; pasted into the popup's
  Server field it fills both. What was typed survives the popup closing.
- **Badge**: *reviewed with DiffNotes* (`/badge.svg`) with Markdown, HTML and PR-template snippets on `/badge`.

### Security

- **File storage is set in the environment**: `STORAGE_TYPE` (`disk`, `b2`, `r2`, `s3`, `minio`) and that provider's
  variables (`B2_*`, `R2_*`, `AWS_*`, `MINIO_*`, `STORAGE_PREFIX`), checked at start. The secret never reaches the
  database, and a stolen super admin session can't point uploads at another bucket. `/admin` shows it read-only.
  A bucket saved on `/admin` before still reads and deletes its files; set it in the environment to keep uploading to it.
- The **set the expiry rule on the bucket** button is gone: an age rule deleted files a PR still showed (a teammate's
  upload keeps the PR alive without rewriting yours; the live demo never expires). The hourly purge deletes files with
  their PR; on Backblaze B2 set *Keep only the last version*. Remove an age rule you added before.
- Notes: a link whose URL held an image could put the image's alt words into the link as HTML attributes (`style`, ...).
- GitHub sign-in: `next=/<tab>/evil.example` redirected off the site after signing in; only a path here is followed now.
- GitHub sign-in finds a user with a password by email but links it only after one sign-in with that password (or
  while already signed in as it): an invitation accepted by someone who doesn't own the address can no longer be used
  to read the real owner's accounts or catch their uploads later. Nothing is dropped for the real owner.
- Super admins can delete another user on `/admin` (with the accounts it owns): the way back in for someone whose
  address a stranger squatted through an invitation.
- Super admins read notes and files only in accounts they belong to, and can't see or make invitations in others;
  their overview of such an account shows counts, no PR titles or uploaders.
- The live demo shows a PR only while a super admin wrote its title, summary and deploy card too.
- A multipart `payload` is held to `MAX_BODY_KB`, and `MIN_FREE_DISK_MB` applies to every upload with notes or files (the database shares the volume).
- Every note and file has its author: an upload replaces only the uploader's own (teammates' stay), so a member can no
  longer wipe someone else's notes by uploading over them. A note is removed by its author or an admin; *remove my
  notes* / *delete my notes* for authors, *remove all notes* for admins. `GET` adds `mine` and `can_delete` per note, `mine` per file, and `can_delete` / `can_delete_all` on the PR.
- `MAX_ACCOUNTS` (10) accounts per user and `MIN_FREE_DISK_MB` (100): open sign-up can't fill the disk.

### Fixed

- Extension: a server sometimes wasn't added on the first **Connect** (the permission prompt closed the popup before
  it saved); the background now finishes the connect once the permission is granted.
- S3 storage: a `5xx`, a `429` or a dropped connection is tried again (3 tries), and a re-upload writes the new files before it
  deletes the old ones, so a file re-uploaded under its name keeps its previous version when the write still fails
  instead of going missing (seen once on B2).
- Extension: the dock's ↑ (and *summary*) used a box GitHub had already re-rendered away, so ↑ did nothing; it
  now scrolls to the live box, clear of the sticky header.

## [1.1.0] - 2026-10-26

### Added

- **Deploy card**: the agent says what shipping a PR takes (migrations, env vars, feature flags, the order of steps,
  rollback) in `deploy`; it is pinned at the top of the summary box and the PR's page, and *copy summary* includes it.
- **Repository rules**: an account admin sets what every upload to a repository must carry (a risk on every note, a
  deploy card, screenshots or a recording for paths like `web/**`); a missing one is refused with `422` saying what to
  add, and the skill and MCP clients add it.
- **Keyboard** in the extension: `j` / `k` next / previous note, `n` notes on / off, `o` opens the note's attachment,
  `?` lists the keys.
- `SECURITY.md`: report vulnerabilities privately through GitHub.

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

[Unreleased]: https://github.com/igorkasyanchuk/diffnotes/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/igorkasyanchuk/diffnotes/releases/tag/v1.1.0
[1.0.0]: https://github.com/igorkasyanchuk/diffnotes/releases/tag/v1.0.0
