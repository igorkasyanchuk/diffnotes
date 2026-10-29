# Changelog

All notable changes to DiffNotes (server, web app, browser extension and agent skill share one version).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `vX.Y.Z` ([how](docs/install.md#releases)).

## [Unreleased]

## [1.6.1] - 2026-10-30

### Security

- **Invitations by email** wait on a dashboard only for a user whose email GitHub proved: someone who made a user for
  another person's address through their own invitation link no longer catches the invitations other teams send it.
- **A long repository name** can't stall the server any more (its parsing was quadratic in a run of `/`).
- **Request bodies** are measured, not taken from `content-length` (a chunked request skipped `MAX_BODY_KB`).
- **Sessions** are stored as SHA-256 (nobody is signed out by the change); the cookie is `__Host-sid` over https (the old
  `sid` is taken only for a session from before); only a Bearer token skips the cross-site check (a Basic auth
  proxy's header doesn't), and a browser without `Sec-Fetch-Site` that sends an `Origin` must send this site's.
- **Login throttles** key IPv6 clients by /64, sweep at most once a minute and keep at most 50,000 entries.
- **Files a bucket refused to delete** are kept and tried again by the hourly purge, instead of staying in the bucket.
- **Extension**: tokens live in the extension's own IndexedDB, out of `storage.local` (which its content scripts can
  read); a file preview opens only on a person's click and only for a file of the PR on the page; demos and videos are
  posted only into its own `demo.html`.
- **Skill**: the base branch is fetched as `refs/heads/$B` (a branch named like a git option can't act as one); what it
  reads (code, PR text, `.diffnotes.yml`, stored notes) is data, never instructions; a PR's code runs only for a trusted
  author and without `DIFFNOTES_TOKEN`. The MCP tool descriptions say the same. `install.sh` works with spaces in `$HOME`.

## [1.6.0] - 2026-10-29

### Added

- **Notes follow the code**: a note keeps its first line's text (`code`); after a push moves the block, the extension
  puts the note on the nearest line that reads so (*moved to line N*), or marks it *code changed since*. The skill sends
  `code` on every line note and its check script verifies it.
- **Diff blocks in notes**: a ` ```diff ` block colours its `+` and `-` lines; the skill uses it for API examples (a
  changed endpoint's response before and after) next to the request.
- **Numbers in the summary**: the skill adds a before / after table when it measured speed, size or load.
- **Note style**: `detail: brief | normal | thorough` in `.diffnotes.yml`, and per person `DIFFNOTES_DETAIL` and
  `DIFFNOTES_HINTS` in the shell profile, over the repository's `detail` and `notes` (never over what it requires).

### Security

- **Extension sign-in checks the issuer**: `/connect`'s answer names the server (`iss`) and the extension trades a code only
  with the server it asked. Before, a malicious server you connected could send the sign-in window on to another server's
  allow page and collect that server's code and verifier. An older server (no `iss`) asks to update or to paste a token.
  The allow page names the server and shows the browser's name as what it says it is.

## [1.5.0] - 2026-10-29

### Added

- **Sign in and connect**: the extension's popup connects a server in one click. It opens the server's `/connect` page in
  the browser's sign-in window; after **allow** the extension gets a one-time code (PKCE, two minutes) and trades it for
  a token of its own, named after the browser. Only the store's extensions (and any in `EXTENSION_IDS`) can get a
  code. **Remove** deletes that token on the server too. Pasting a token still works (Safari has no sign-in window).
- **Large summary**: *expand ⤢* in the box (and ⤢ in the dock) opens the whole summary, deploy card and risk map in a
  large window; images there are full size, a click on one opens the gallery over it.
- **Docs page** (`/docs`): get started, asking the agent, the diff, repository rules, team, tips and troubleshooting.

### Changed

- **Note themes style the box too**: the box above the diff, the dock and the summary pop follow the chosen look (sticky,
  terminal, paper, contrast and the rest), not only the notes.

### Fixed

- **show more did nothing** when two copies of the extension ran on one page (the store one and an unpacked one, or an
  old copy left after an update): each toggled it once. The newest copy now owns the page and the others draw nothing, unless
  only an older one has notes for the PR (a second copy with no server connected): that one keeps it.

## [1.4.0] - 2026-10-28

### Added

- **`.diffnotes.yml`**: a repository says how its PRs are annotated (language, tone, paths to skip, where screenshots
  go, risk and deploy card required, what the summary covers); the skill follows it, the server's rules still enforce.
- **Preview-deploy links**: `preview` (the PR's preview deploy, https) and a note's `try` (a path on it) give
  *try it on the preview ↗* under the note in the diff and on the PR's page; the skill finds the preview from the PR's
  GitHub deployments or the preview bot's comment.
- **Stacked pull requests**: `stack` lists the PRs of a stack, bottom first; the summary box and the PR's page show it
  with this PR highlighted and mark the others that have notes.
- **Skill versions**: the served skill carries its version (the release plus a hash of the skill and this server's
  limits) and `/skill/version` says the current one; an
  installed copy that is older asks you to re-run the install (it never follows the server's copy on its own).
- **Server admin**: each account's files, size against its quota and the estimated monthly storage cost at B2, R2
  or S3 list prices (as of 27 Oct 2026), the biggest account first, with totals.

### Changed

- **Notes and files are kept 365 days** after a PR's last upload by default (was 30); set `RETENTION_DAYS` for less. PRs and files
  now live longer against `MAX_PULLS` and `MAX_ACCOUNT_MB`: raise them if accounts fill up.
- **Deploy card**: list items starting with `migration:`, `env:`, `flag:`, `step:` or `rollback:` show that kind as a tag.

### Security

- Skill: branch names (which a PR's author picks, and which may hold shell syntax such as `x$(…)`) are read from the
  CLI into quoted variables and never typed into a command; `git fetch` / `git merge-base` used to take them as typed.
  Re-run the install to get it.
- Extension: what another connected server sends (notes, preview, stack) is checked before it is drawn, so a bad value
  shows nothing instead of breaking the box; preview links never leave the preview's own path or host.

## [1.3.1] - 2026-10-27

### Added

- **GitHub photos**: people who sign in with GitHub show their photo next to their name (dashboard, latest uploads,
  members, a PR's authors). The server fetches it and serves it to teammates only, so the app's pages still load
  nothing from third parties; others keep their initials.

### Changed

- The dashboard's pull requests line up in columns.
- Extension popup: a link to diffnotes.dev in its header.
- Landing: says the extension runs in Chrome, Edge, Brave and Arc, with Firefox and Safari coming soon.
- Landing: *start in 5 minutes* (this server) and *self-host it* (your own) are two separate panels with an “or” between.
- `authors` on a PR is now a list of `{name, avatar}` (was names).

## [1.3.0] - 2026-10-27

### Added

- **Extension: 11 more note themes**: outline, card, tinted, dashed, blue, green, purple, mono, contrast, terminal and
  paper. The standard theme has a thin orange border, so notes stand out from the code.
- **Extension: summary switch** next to the notes switch: hides the box's summary, deploy card and risk map, remembered
  across PRs (a click on the box's title does the same).
- **Links between notes**: `[text](#note:path:line)` in a note jumps to the note on that line, in the diff and on the
  PR's page; the skill says when to use them.
- **Who wrote the notes**: the dashboard, an account's latest uploads and a PR's page show the uploader with an initials avatar.
- **Dashboard pages**: 20 annotated PRs at a time with newer / older, and the total.
- **Filters** for an account's members and the server admin's users: by name or email, and by role.
- **SEO**: `/demo` (when set), `/badge` and `/privacy` have their own title and description and are in the sitemap; every
  page sets the tab's title.

### Changed

- Landing: the install command fits without a scrollbar; the live demo is linked in the header and under the command.
- Members tab: a visible note that DiffNotes sends no emails (send the invitation link yourself), and the two ways to
  invite (a person, an open link) as two cards.
- An account's latest uploads fit the page instead of scrolling sideways.
- “Start in 3 minutes” is now 5: closer to what the setup takes.

## [1.2.0] - 2026-10-27

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
- **Setup steps** (`/welcome`): after joining or signing up, three steps that tick themselves (agent connected,
  extension connected, first notes), each with its own token made in place; the invitation page says who invited
  you and what comes next.
- **Open invite links**: anyone with the link joins as a member until it expires (5 min to 1 day), signed in, with
  GitHub or with an email and password.
- **Extension: note themes**: loud, sticky, standard, quiet, compact or ghost, picked in the popup.
- **Feedback everywhere**: the web app says what just happened (saved, copied, removed, invited) and buttons show
  when they're working; the extension popup says what connecting is doing.
- **Landing**: start on this server in four steps (with a prompt to give your agent), self-hosting as the option.
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

[Unreleased]: https://github.com/igorkasyanchuk/diffnotes/compare/v1.6.1...HEAD
[1.6.1]: https://github.com/igorkasyanchuk/diffnotes/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/igorkasyanchuk/diffnotes/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/igorkasyanchuk/diffnotes/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/igorkasyanchuk/diffnotes/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/igorkasyanchuk/diffnotes/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/igorkasyanchuk/diffnotes/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/igorkasyanchuk/diffnotes/releases/tag/v1.2.0
[1.1.0]: https://github.com/igorkasyanchuk/diffnotes/releases/tag/v1.1.0
[1.0.0]: https://github.com/igorkasyanchuk/diffnotes/releases/tag/v1.0.0
