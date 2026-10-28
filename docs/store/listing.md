# Chrome Web Store listing

← [Browser extension](../extension.md)

What to paste into the Chrome Web Store developer dashboard for `extension/`. Package: zip the contents of
`extension/` (the folder's files at the zip's root). The version is `extension/manifest.json`'s, the same as the server's.

## Store listing

**Name**: DiffNotes

**Short description** (≤ 132 characters, 116):

> Your coding agent's notes, screenshots and live demos, shown inside GitHub, GitLab and Bitbucket pull request diffs.

**Detailed description**:

> DiffNotes puts the "why" of a pull request next to the lines that changed.
>
> Your coding agent (Claude Code, Codex, Cursor and other Agent Skills tools) writes a plain-language note for each
> changed block, plus screenshots, Markdown reports and small HTML demos, and uploads them to your team's own DiffNotes
> server. This extension shows them inside the diff on GitHub, GitLab and Bitbucket:
>
> • a summary box above the files, with links to the agent's reports
> • notes on the changed lines, with a risk level where reviewers should look hardest
> • screenshot galleries and a before/after slider for UI changes
> • previews of attached Markdown, CSV and text files
> • small interactive HTML demos, run in a locked sandbox with no network access
> • a floating dock and one switch to hide every note
> • a deploy card: migrations, env vars, flags and rollback, pinned on top
> • keyboard: j / k between notes, n to hide them, ? for the keys
> • authors and admins remove notes right in the diff
>
> Nothing is posted to the pull request: no bot comments, no notifications. Notes live on a DiffNotes server you or your
> company runs (free, open source, MIT) and are visible only to your team.
>
> Setup: install DiffNotes on your server (one Docker container), make a token on its Settings page, then open this
> extension's popup and connect with the server address and the token. You can connect several servers.
>
> Source and docs: https://github.com/igorkasyanchuk/diffnotes

**Category**: Developer Tools

**Language**: English

**Images** (this folder):

| File | Use |
|---|---|
| `../../extension/icon128.png` | store icon, 128×128 |
| `screenshot-1-bar.png` | screenshot: the summary bar above the diff |
| `screenshot-2-note.png` | screenshot: a note next to the changed lines |
| `screenshot-3-gallery.png` | screenshot: the screenshot gallery |
| `screenshot-4-live.png` | screenshot: a live HTML demo |
| `promo-small-440x280.png` | small promo tile |

Screenshots are 1280×800, rendered from the landing page's demo film (`web/demo.tsx`) with Playwright: the film's
screen stretched to the viewport, controls hidden, one scene per shot (scene dots 2–5, after their animations).

**Website**: https://diffnotes.dev · **Support**: https://github.com/igorkasyanchuk/diffnotes/issues

## Privacy practices

**Single purpose**:

> Show a team's DiffNotes annotations (notes, screenshots, files and demos written for a pull request) inside the
> pull request's diff on GitHub, GitLab and Bitbucket.

**Permission justifications**:

| Permission | Justification |
|---|---|
| `storage` | Keeps the DiffNotes servers the user connected and their access tokens, which notes the user folded, whether notes are switched off, how notes look, and, for pull requests with notes opened in the last 60 days, their repository and number with hashes of the notes shown (to mark notes changed since the last visit). Stored locally in the browser only. |
| `identity` | **Sign in and connect**: `identity.launchWebAuthFlow` opens the user's own DiffNotes server's sign-in page in the browser's sign-in window; after the user presses Allow there, the server hands back a one-time code (PKCE) that the extension trades for its access token. No Google account or other identity is read. |
| Host `https://github.com/*`, `https://gitlab.com/*`, `https://bitbucket.org/*` | The content script runs on pull request pages of these sites to draw the notes next to the changed lines of the diff. It only reads the page to find files and line numbers. |
| Optional host `https://*/*` | Requested at runtime for exactly one origin, the DiffNotes server the user types in the popup (each team runs its own server, so the address isn't known in advance). Used to fetch that server's notes and files with the user's token, and to remove notes when the user asks (authors and admins only). Removed again when the user removes the server. |
| Optional host `http://localhost/*`, `http://127.0.0.1/*` | The same, for a DiffNotes server running on the user's own machine (development and trials). Plain `http://` is allowed only for these. |
| Content scripts | See the host permissions above: GitHub, GitLab and Bitbucket pull request pages only. |
| `web_accessible_resources` (`demo.html`) | A sandboxed extension page (manifest `sandbox`, no network, opaque origin) that runs a note's HTML demo inside the diff, so untrusted demo code never runs in the site's page. Exposed with `use_dynamic_url` so sites can't detect the extension. |

**Remote code**: No. All JavaScript is in the package. HTML demos attached to notes are data rendered in a sandboxed
page with a CSP that blocks scripts from loading anything (`default-src 'none'`), not code the extension executes.

**Data usage** (check boxes):

| Category | Collected? | Notes |
|---|---|---|
| Personally identifiable information | No | |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | **Yes** | The access tokens for the user's DiffNotes servers (pasted, or made by the server when the user signs in and connects), kept in local extension storage and sent only to that server. |
| Personal communications | No | |
| Location | No | |
| Web history | No | The extension reads the current GitHub/GitLab/Bitbucket pull request URL to ask the user's own server for its notes; it sends no history. Locally it keeps the repository and number of pull requests with notes opened in the last 60 days, to mark notes changed since. |
| User activity | No | |
| Website content | **Yes** | The repository and pull request number of the open pull request page are sent to the user's own DiffNotes server to fetch its notes. |

Certifications (all true):

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**: https://diffnotes.dev/privacy (every DiffNotes server serves the same page at `/privacy`).
