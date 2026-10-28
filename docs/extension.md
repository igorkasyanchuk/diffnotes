# Browser extension

← [README](../README.md)

The extension shows DiffNotes notes inside the pull request diff on **GitHub** (`/pull/<n>/changes`), **GitLab**
(`/-/merge_requests/<n>/diffs`, gitlab.com) and **Bitbucket Cloud** (`/pull-requests/<n>/diff`). It runs on
`github.com`, `gitlab.com` and `bitbucket.org` only and talks to the servers you connect; none of those sites ever see
the notes. Self-hosted GitLab: the server takes `gitlab.acme.dev/team/app` repositories already; the extension doesn't
run on your GitLab's host yet.

## Install (Chrome, Edge, Brave, Arc)

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/fmnbgmeahjhfakpcmhimjjjplimdiibd), or load it from this repository:

1. Open `chrome://extensions` and switch on **Developer mode**.
2. **Load unpacked** → pick the `extension/` folder.
3. Pin **DiffNotes**, open its popup and press **Sign in and connect** (the **Server** field says `https://diffnotes.dev`;
   type your own server's address instead if you run one). Allow access to that server, sign in on the page that opens
   and press **allow**: the window closes and the server is listed with your email. Nothing to copy. A copy loaded
   unpacked has an id of its own: a server signs it in only once that id is in its `EXTENSION_IDS` ([install](install.md));
   until then, use step 4.
4. No sign-in window (Safari), or you'd rather paste: under **Use a token instead**, make a token on your server's
   **Settings** and paste the one line shown there for the extension (`{"server":"https://reviews.example.com","token":"dn_…"}`)
   into **Server**: it fills both fields. Press **Connect**. What you typed is kept if the popup closes meanwhile, and a
   connect the permission prompt interrupted completes on its own. The token goes with every request, so the server
   must be `https://` (plain `http://` only for `localhost`).

### How Sign in and connect works

The popup opens `<server>/connect` in the browser's sign-in window (`identity.launchWebAuthFlow`) with the extension's
own redirect address, a random `state` and a PKCE challenge. Signed in there, **allow** gives a one-time code (two
minutes) that the browser hands back to the extension only; the extension trades it, with the PKCE verifier that never
left it, at `POST /api/v1/connect/token` for a token named after the browser (`browser extension · Chrome on macOS`),
listed on **Settings** like any other. The server gives codes only to the redirect addresses of the store's extensions
and any in `EXTENSION_IDS` ([install](install.md)), so another extension can't open the page and collect a token. **Remove** in the
popup deletes that token on the server too (a pasted one stays: your agent may use it as well).

The store version updates itself. Unpacked: after `git pull`, press the reload icon on the extension's card.

## Firefox

The same `extension/` folder works in Firefox 154 or later (one manifest for both browsers):

1. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `extension/manifest.json`
   (a temporary add-on is gone after a restart; for a permanent one, sign it with `npx web-ext sign -s extension`).
2. In `about:addons` → DiffNotes → **Permissions**, make sure github.com, gitlab.com and bitbucket.org are allowed.
3. Connect a server from the popup as above. The popup may close when Firefox asks for access to your server: the
   server is connected anyway once you allow it (open the popup again to see it).

## Safari

Safari takes the same folder through Xcode's converter, which wraps it in a macOS app (not built here):

```bash
xcrun safari-web-extension-converter extension/ --app-name DiffNotes --macos-only
```

Build and run the generated project in Xcode, then enable it in Safari → Settings → Extensions (for an unsigned
build, first allow unsigned extensions in Safari's Develop menu). Safari has no sandboxed extension pages, so live
`.html` demos and screen recordings show a hint instead: open them from **open in DiffNotes**.

## How notes look

The popup's **Notes look** picks a theme. By loudness: **loud** (tinted, thick border), **sticky** (a yellow sticky
note), **standard** (the default: a thin orange border), **quiet** (a line at the left only), **compact** (small and
tight) and **ghost** (faded until you hover it). Shapes: **outline**, **card** (raised, with a shadow), **tinted**,
**dashed**. Colours: **blue**, **green**, **purple**, **mono**. Moods: **contrast** (black on white), **terminal**
(green on black), **paper** (warm, serif). It applies to open pages right away and is kept in the browser.

## Several servers

The popup lists every connected server with your email on it; add more with **Sign in and connect** or a token (different teams, clients,
self-hosted and a colleague's server…). On a PR, all of them are asked: their notes show together, the toolbar badge
counts them all, and the summary box shows each server's summary under its name. Remove a server with **Remove**.

## What you see in the diff

Open a PR's **Files changed** tab:

| | |
|---|---|
| **Summary box** above the first file | the PR summary, linked reports, *notes* and *summary* on/off switches (both remembered; a click on the box's title flips *summary*), expand / collapse all, *copy summary*, open in DiffNotes |
| **Links between notes** | a note's link to another one (`#note:path:line`, written by the agent) scrolls to that note and flashes it |
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
| **Deploy card** | what shipping the PR takes (migrations, env vars, flags, rollback), pinned at the top of the box, each step tagged with its kind; *copy summary* includes it |
| **Stack** | on a stacked PR, the stack bottom first with this PR highlighted; the others link to their diff (*DN*: they have notes too) |
| **Preview deploy** | *preview ↗* in the box and *try it on the preview ↗* under notes open the PR's preview deploy at that screen |
| **Keyboard** | `j` / `k` next / previous note, `n` notes on / off, `o` opens the current note's attachment, `?` lists the keys (press it again for the site's own help). Not while typing; while notes show, `j` / `k` take over the site's own (GitLab and Bitbucket use them for files), and on a PR with notes `n` replaces GitLab's next-thread key |
| **Remove** | a note's author and account admins see *remove note* under it; in the box, admins get *remove all notes* and authors *remove my notes*; both ask first |

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
