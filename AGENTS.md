# DiffNotes

See README.md for what it is. Same stack and habits as specdrop.

## Stack

- Server: Node 24 + Hono, built-in `node:sqlite`, `.ts` run directly through type stripping (no build step):
  relative imports need `.ts`, `import type` for types, no `enum` / `namespace` / parameter properties.
- Web: Vite + React 19, no router lib (`web/main.tsx` switches on `location.pathname`), plain CSS tokens in `web/styles.css`.
- Extension: Chrome MV3, plain JS, no build. `extension/markdown.js` is the one Markdown renderer, also imported by the web app.

## Layout

```
server/db.ts      schema, password hashing, bootstrap (first admin + account), tokens, purgeExpired
server/app.ts     all routes: auth (password, GitHub OAuth), invites, accounts, repos, tokens, /api/v1 pulls (skill + extension), /mcp (MCP tools over the same savePull/findPull), /files, /install.sh
server/storage.ts file bytes on disk or in an S3-compatible bucket (STORAGE_TYPE + provider env vars, SigV4 signing, retries, bucket check);
                  PRICES: hard-coded list prices (dated PRICES_AS_OF) for /admin's monthly cost estimate
server/index.ts   start, hourly purge, SIGTERM
docs/             user docs linked from README (install, deploy, skill, extension, accounts, storage, security, api) + images;
                  docs/store/ the Chrome Web Store listing and its images
web/main.tsx      routing, public + app (sidebar) layouts, login, invite, privacy, dashboard, account, pull preview, settings
web/landing.tsx   landing page (GitHub walkthrough, install), plus the Code/Copy block; its CSS is web/landing.css
skill/diffnotes/  the agent skill, served at /skill/SKILL.md with {{HOST}}, {{VERSION}} and the limits filled in; /skill/version
                  is the release plus a hash of that skill, which an installed copy compares with its own (it then asks the user to re-run install.sh)
.diffnotes.yml    this repository's own annotation rules, which the skill reads from a PR's base branch
extension/        manifest, demo.html (sandbox for .html demos), background (holds the tokens, asks every connected server), content (draws on GitHub, GitLab and Bitbucket diffs:
                  box above the diff, floating dock with a notes switch once it scrolls away), popup (servers list)
Dockerfile        image (ghcr.io/igorkasyanchuk/diffnotes, published by .github/workflows/ci.yml for each vX.Y.Z tag; CI also runs the checks below
                  on every push); docker-entrypoint.sh gives /data to `node` and drops root. docker-compose.yml, render.yaml, fly.toml: deploy templates
SECURITY.md       how to report a vulnerability (GitHub private advisories)
CHANGELOG.md      one version for server, web, extension (package.json + extension/manifest.json), tagged vX.Y.Z
```

## Rules

- Keep it small: few files, no dependency for what a few lines do. Mark deliberate shortcuts with `// ponytail:`.
- Access: everything about a PR is visible only to members of the account that owns its repository; other
  accounts' rows answer 404. Tokens and sessions are stored as sha256 only; the extension keeps its tokens in its own
  IndexedDB (`vault`, background.js), never in `storage.local`, which content scripts can read.
- Roles per account (`memberships.role`): `owner` (made it; can't be removed or demoted; deletes the account),
  `admin` (invites, changes roles, manages repositories, renames), `member` (reads, uploads, removes its own notes;
  every note and file has its author, `annotations.user_id` / `files.user_id`, and an upload replaces only the uploader's own). `users.admin` = super
  admin: runs the server, sees `/admin` (`/api/admin/*`, 404 for others) and may open and manage any account,
  but reads notes and files (`isMember()`) only in accounts it belongs to.
  The first user (bootstrap) is a super admin.
- Annotation Markdown is untrusted: render it only through `dnMarkdown` (escapes everything, keeps http(s) and relative URLs),
  deploy cards through `dnDeploy`; any other text from a server goes in as text (`textContent`, JSX), never as HTML.
- A PR's `preview` is https only (`previewUrl`) and a note's `try` a path (`tryPath`), joined only by `dnPreviewUrl`
  (markdown.js): it stays under the preview's own path (no other host or scheme, no `../`). The extension re-checks what
  every connected server sends: a bad value draws nothing instead of breaking the box. External links get `rel=noopener noreferrer`.
- `/files/*` is served with `CSP: sandbox` + `nosniff`; text uploads as `text/plain`. `.html` demos are the exception:
  `text/html` with `DEMO_CSP` (app.ts; opaque sandbox, no network). The extension runs them only in its sandboxed
  `extension/demo.html` (manifest `sandbox` + the same CSP), never in github.com's page. Keep the two policies equal.
  Note videos (.mp4/.webm) play in that demo.html too: github.com's CSP refuses data:/blob: media in its page.
- Uploads: allow-list in `EXT_TYPES` (db.ts), checked by content in `fileType()` (app.ts), all through `savePull()` (PUT and MCP).
  Every limit is an env var (`MAX_*`, docs/install.md); the served skill shows the server's values (`{{MAX_FILE_MB}}`…). Every file has a `files` row
  (size, type, backend `disk|s3`); stats and quotas read the rows, never the disk or the bucket.
- Deleting PRs goes through `dropPulls()` so their files are removed from whichever backend holds them.
- Keep docs/ in sync when routes, limits or features change (and the skill, `skill/diffnotes/SKILL.md`). In the skill's
  shell snippets, values from a PR (branch names, titles) come from the CLI into quoted variables (`"$B"`), never typed
  into a command: a branch can be named `x$(…)`. The skill never fetches and follows instructions on its own. A new env var:
  a row in docs/install.md's Environment table (the one reference) and a line in docker-compose.yml and the templates.
- A PR's own fields (title, `head_sha`, summary, deploy card, preview, stack) are its latest upload's; `fields_by` says
  whether one person wrote them all (the live demo, `DEMO_PR`, shows only a PR whose fields and notes are all a super admin's;
  it is public: `/api/demo` and its files answer signed-out visitors).
- Repositories: `owner/name` = GitHub, `host/path` = GitLab (any host but bitbucket.org) or Bitbucket; `repoName()`
  (app.ts) normalizes URLs and clone addresses, the web app's `prUrl()` builds links back. Unique per account (not
  server-wide): always look names up within the caller's accounts.
- Extension sign-in (`/connect`, app.ts): one-time code + PKCE, codes only to `EXTENSION_IDS` redirect addresses; the
  background (not the popup) runs `launchWebAuthFlow`. Content scripts: the newest copy on a page owns it (`dnOwner`), a copy that gets notes takes it back.
- Bearer tokens authenticate only `/api/v1/*`, `/files/*` and `/mcp` (which takes nothing else, never the cookie); cookie writes need `Sec-Fetch-Site: same-origin`
  (or this site's `Origin`); only a Bearer header skips that check (a Basic auth proxy's doesn't). Invitations by email are listed only to a user whose email GitHub proved.
- The web app's page gets `PAGE_CSP` and its `__ORIGIN__` filled (app.ts `page()`); keep index.html's SEO tags there.
- Diff DOM, one adapter per host in `SITES` (`extension/content.js`); if notes stop appearing, re-check these first:
  GitHub React view (`h3[class*=file-name]`, `td[data-diff-side][data-line-number]`) and classic (`.file-header[data-path]`,
  `td.blob-num`); GitLab rapid diffs (`diff-file`, `rd-diff-file-copy-clipboard`, `td.rd-line-number[data-position] a[data-line-number]`);
  Bitbucket (`[data-qa=branch-diff-file]`, `[data-qa=bk-filepath]`, `[data-old-line-number]`/`[data-new-line-number]`, rows `[role=row]`).

## Commands

```bash
npm test          # vitest, server/app.test.ts is one sequential story; edges.test.ts the limits and errors
npm run coverage  # server + extension/markdown.js, fails under 95% lines/statements/functions, 90% branches
npm run typecheck
npm run build
```
