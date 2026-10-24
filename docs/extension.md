# Browser extension

← [README](../README.md)

The extension shows DiffNotes notes inside the pull request diff on **GitHub** (`/pull/<n>/changes`), **GitLab**
(`/-/merge_requests/<n>/diffs`, gitlab.com) and **Bitbucket Cloud** (`/pull-requests/<n>/diff`). It runs on
`github.com`, `gitlab.com` and `bitbucket.org` only and talks to the servers you connect; none of those sites ever see
the notes. Self-hosted GitLab: the server takes `gitlab.acme.dev/team/app` repositories already; the extension doesn't
run on your GitLab's host yet.

## Install (Chrome, Edge, Brave, Arc)

Until it is in the Chrome Web Store, load it from this repository:

1. Open `chrome://extensions` and switch on **Developer mode**.
2. **Load unpacked** → pick the `extension/` folder.
3. Pin **DiffNotes**, open its popup, enter your server (`https://reviews.company.com`) and a token from the server's
   **Settings**, press **Connect** and allow access to that server. The token goes with every request, so the server
   must be `https://` (plain `http://` only for `localhost`).

After `git pull`, press the reload icon on the extension's card.

## Firefox

The same `extension/` folder works in Firefox 154 or later (one manifest for both browsers):

1. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `extension/manifest.json`
   (a temporary add-on is gone after a restart; for a permanent one, sign it with `npx web-ext sign -s extension`).
2. In `about:addons` → DiffNotes → **Permissions**, make sure github.com, gitlab.com and bitbucket.org are allowed.
3. Connect a server from the popup as above. If the popup closes when Firefox asks for access to your server, open it
   again and press **Connect** once more.

## Safari

Safari takes the same folder through Xcode's converter, which wraps it in a macOS app (not built here):

```bash
xcrun safari-web-extension-converter extension/ --app-name DiffNotes --macos-only
```

Build and run the generated project in Xcode, then enable it in Safari → Settings → Extensions (for an unsigned
build, first allow unsigned extensions in Safari's Develop menu). Safari has no sandboxed extension pages, so live
`.html` demos and screen recordings show a hint instead: open them from **open in DiffNotes**.

## Several servers

The popup lists every connected server with your email on it; add more with the same form (different teams, clients,
self-hosted and a colleague's server…). On a PR, all of them are asked: their notes show together, the toolbar badge
counts them all, and the summary box shows each server's summary under its name. Remove a server with **Remove**.

## What you see in the diff

Open a PR's **Files changed** tab:

| | |
|---|---|
| **Summary box** above the first file | the PR summary, linked reports, *notes* on/off switch, expand / collapse all, *copy summary*, open in DiffNotes |
| **Changed since your last visit** | on a PR you opened before, notes added or changed since get a *new* / *updated* tag, and the box and dock say “N changed since your last visit” (a click jumps to the first). Remembered in the browser for 60 days |
| **Copy summary** | copies the PR summary as Markdown for the PR description; attachments become links to your DiffNotes server (readers need to sign in there). Nothing is posted |
| **File cards** under file headers | notes about a whole file (new, renamed, deleted) |
| **Line notes** above changed blocks | the “why” for that block; click the header to collapse it; it stays collapsed after a reload until the note changes |
| **Show more / less** | long notes are cut to a few lines |
| **Gallery** | click an image: every image of that note, ← → to move, Esc to close |
| **Previews** | links to attached `.md` / `.csv` / `.txt` open rendered in place |
| **Live demos** | an attached `.html` runs in a sandboxed frame under its note (no network, no access to GitHub); *expand* opens it at phone, tablet or desktop width |
| **Floating dock** | appears when the box scrolls away: note count, notes switch, summary popover, back to top |
| **Where to look hardest** | notes the agent marked `high` / `medium` / `low` risk, listed first in the box; click one to jump to it |
| **Before / after** | a `-before` / `-after` image pair is one image with a drag handle; ⤢ opens it large (Esc closes) |
| **Diagrams** | ` ```mermaid ` flowcharts in a note are drawn in place |
| **Remove** | the PR's uploader and account admins see *remove note* under each note and *remove all notes* in the box; both ask first |

Colors follow the site's light or dark theme. Notes whose line is not in the diff (a collapsed or not yet loaded file, or
a line that changed since) are listed in the summary box instead of being lost.

<img src="images/github-summary.png" alt="Summary box" width="700">

| GitLab merge request | Bitbucket pull request |
|---|---|
| <img src="images/gitlab.png" alt="DiffNotes notes on a GitLab merge request diff" width="420"> | <img src="images/bitbucket.png" alt="DiffNotes notes on a Bitbucket pull request diff" width="320"> |

## Troubleshooting

| You see | Do |
|---|---|
| nothing at all | the PR has no notes on your servers, or you're not in the account that owns the repository |
| “can't reach …” in the box | open the popup and connect that server again (Chrome's permission for it is missing) |
| “… rejected the token” | the token was deleted: make a new one in Settings and reconnect |
| notes in the box, not in the diff | expand the file on the site, or the code moved since the notes were written: re-run the skill |
