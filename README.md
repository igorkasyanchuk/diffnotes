<p align="center"><img src="public/icon.svg" width="56" alt=""></p>

<h1 align="center">diffnotes</h1>

<p align="center"><b>Your coding agent explains the pull request. Your team reads it in the diff.</b><br>
Free · hosted at diffnotes.dev or self-hosted · open source (MIT) · GitHub, GitLab, Bitbucket</p>

<p align="center">
<a href="https://chromewebstore.google.com/detail/fmnbgmeahjhfakpcmhimjjjplimdiibd"><img src="https://img.shields.io/chrome-web-store/v/fmnbgmeahjhfakpcmhimjjjplimdiibd?label=Chrome%20extension" alt="Chrome Web Store"></a>
<a href="https://github.com/igorkasyanchuk/diffnotes/pkgs/container/diffnotes"><img src="https://img.shields.io/badge/docker-ghcr.io-blue" alt="Docker image"></a>
<a href="LICENSE"><img src="https://img.shields.io/github/license/igorkasyanchuk/diffnotes" alt="MIT license"></a>
<a href="https://diffnotes.dev"><img src="https://diffnotes.dev/badge.svg" alt="Reviewed with DiffNotes"></a></p>

<p align="center"><a href="https://diffnotes.dev"><b>diffnotes.dev</b></a> · <a href="https://diffnotes.dev/demo">live demo</a> · <a href="#quick-start">quick start</a> · <a href="#self-host">self-host</a> · <a href="https://diffnotes.dev/docs">docs</a></p>

<p align="center"><a href="https://diffnotes.dev/demo"><img src="docs/images/demo.gif" alt="DiffNotes on a GitHub pull request: summary box, deploy steps, before/after screenshots, a live demo and line notes inside the diff" width="860"></a></p>

## TL;DR

- Your agent (Claude Code, Codex, Cursor…) **annotates a PR**: a plain-language “why” for each changed block, plus
  screenshots, short screen recordings, Markdown reports, CSVs and small interactive HTML demos. Through the skill or the MCP endpoint.
- The notes go to **a DiffNotes server**, never to GitHub, GitLab or Bitbucket: no bot comments, no notification noise. Use
  the free one at [diffnotes.dev](https://diffnotes.dev), or run your own and code context never leaves your infrastructure.
- Reviewers with the **browser extension** (Chrome, Edge, Brave, Arc) see them **inside the diff on GitHub, GitLab or Bitbucket**: a summary box on top, notes on the
  changed lines, image galleries, file previews, what changed since their last visit, one switch to hide everything.
- Notes **expire on their own** (after a year by default). Files on disk or in any S3-compatible bucket (Backblaze B2, R2, S3, MinIO).
- Up and running in **a few minutes**: a GitHub sign-in, one command for your agent, one extension (or one container of your own).

<p align="center"><img src="docs/images/flow.svg" alt="agent → diffnotes server ← browser extension → github.com PR" width="860"></p>

## Why

| | |
|---|---|
| **Review faster** | Reviewers read *why* a block changed before reading *how*. Fewer “what does this do?” round trips. |
| **Context from the author** | The agent that wrote the code explains it while it still knows the decisions and trade-offs. |
| **Screenshots in the diff** | UI changes come with before/after or mobile/desktop shots next to the lines that caused them. |
| **Zero noise** | Nothing is posted to the PR. The conversation stays for humans. |
| **Your data** | Self-hosted, invite-only (or sign-up with GitHub), per-account access. Code context never leaves your infrastructure. |
| **Any agent, any team** | One skill for every Agent Skills tool; one extension for several servers (teams, clients). |

## See it

| On GitHub | |
|---|---|
| <img src="docs/images/github-summary.png" alt="Summary box above the diff" width="420"> | **Summary box** above the files: the PR's summary, linked reports, a notes on/off switch, expand/collapse all. |
| <img src="docs/images/gallery.png" alt="Image gallery" width="420"> | **Gallery**: several images in one note (mobile + desktop), ← → to flip, Esc to close. |
| <img src="docs/images/file-preview.png" alt="Markdown report preview" width="420"> | **Previews** of attached `.md`, `.csv` and `.txt` files, rendered in place. |
| <img src="docs/images/html-demo.png" alt="A live HTML demo in a note" width="420"> | **Live demos**: a small `.html` file runs in a locked sandbox under its note (no network, no access to GitHub); expand it at phone, tablet or desktop width. |
| <img src="docs/images/dock.png" alt="Floating dock" width="420"> | **Floating dock** once you scroll: note count, notes switch, summary popover. Long notes get *show more / less*. |

| In the app | |
|---|---|
| <img src="docs/images/web-pull.png" alt="A pull request's notes in the web app" width="420"> | Every annotated PR, with its notes and attachments. |
| <img src="docs/images/account-overview.png" alt="Account overview" width="420"> | **Accounts** with roles (owner, admin, member), invitations, repositories, storage per repository. |
| <img src="docs/images/server-admin.png" alt="Server admin" width="420"> | **Super admin**: users, accounts, uploads, disk, and where files are stored. |

## Quick start

On the free server, about 3 minutes:

1. **Sign in** at [diffnotes.dev](https://diffnotes.dev/login) with GitHub: you get a team account to invite people into.
2. **Add the extension** from the [Chrome Web Store](https://chromewebstore.google.com/detail/fmnbgmeahjhfakpcmhimjjjplimdiibd)
   (Edge, Brave and Arc too). It opens a tab: **Sign in and connect** → **allow**. Nothing to copy.
3. **Set up your agent** (Claude Code, Codex, Cursor, any Agent Skills tool): [diffnotes.dev/welcome](https://diffnotes.dev/welcome)
   gives one command with your token in it. Run it once.
4. On a branch with an open pull request, ask your agent: **“annotate this PR with diffnotes”**, then open the PR's *Files changed* tab.

No skills in your agent? Use the MCP endpoint instead: `claude mcp add --transport http diffnotes https://diffnotes.dev/mcp --header "Authorization: Bearer $DIFFNOTES_TOKEN"` ([more](docs/skill.md#mcp-instead-of-the-skill)).

## Self-host

Code that must not leave your company: one container and a volume, on any Docker host.

```bash
docker run -d -p 3000:3000 -v diffnotes:/data \
  -e ADMIN_EMAIL=you@your-company.com -e PUBLIC_URL=https://diffnotes.your-company.com ghcr.io/igorkasyanchuk/diffnotes
docker logs <container> | grep "first admin"        # the generated password
```

Put it behind HTTPS, then follow the quick start with your server's address. Docker Compose, Coolify, Render, Fly.io and
Railway: [deploy](docs/deploy.md); every setting: [install & configure](docs/install.md).

## Docs

| | |
|---|---|
| [Install & configure](docs/install.md) | Docker, environment variables, first admin, password reset, upgrades, backups |
| [Deploy](docs/deploy.md) | Docker Compose, Coolify, Render (one-click), Fly.io, Railway; one instance only |
| [Agent skill](docs/skill.md) | Install, token, how the agent writes notes, payload format, allowed files |
| [Browser extension](docs/extension.md) | Install (Chrome, Edge, Brave, Arc; Firefox and Safari as developer installs), several servers, GitHub / GitLab / Bitbucket, what you see, troubleshooting |
| [Accounts & roles](docs/accounts.md) | Owner / admin / member, invitations, repository rules, super admin, overview pages |
| [File storage](docs/storage.md) | Disk or S3-compatible (Backblaze B2, Cloudflare R2, AWS S3, MinIO), expiry |
| [Security](docs/security.md) | Access model, upload checks, sandboxing, tokens, secrets; report a vulnerability: [SECURITY.md](SECURITY.md) |
| [API](docs/api.md) | The HTTP API the skill and the extension use |
| [Development](AGENTS.md) | Stack, layout, commands, code rules |
| [Changelog](CHANGELOG.md) | What changed in each version; releases are tagged `vX.Y.Z` |
| [Privacy](https://diffnotes.dev/privacy) · [Terms](https://diffnotes.dev/terms) | What the extension and a server keep; the license and the hosted service's terms (every server serves both) |

## Contributing

Issues and pull requests are welcome: [open an issue](https://github.com/igorkasyanchuk/diffnotes/issues) for a bug or an
idea, and see [AGENTS.md](AGENTS.md) for the stack and the checks to run. Security reports go privately: [SECURITY.md](SECURITY.md).
If DiffNotes saves your reviewers time, a ⭐ helps other people find it.

## License

[MIT](LICENSE): use it, change it, host it, sell it; keep the copyright notice. Terms of the hosted service: [diffnotes.dev/terms](https://diffnotes.dev/terms).
