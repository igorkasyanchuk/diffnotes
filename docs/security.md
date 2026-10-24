# Security

← [README](../README.md)

## Access

- **Invite-only.** The first admin is created on first boot; everyone else needs an invitation link (7 days, one use).
- **Per account.** A PR's notes and files are visible only to members of the account that owns its repository (and
  super admins). Other users get `404`, so they can't even tell a PR is annotated.
- **Sessions**: an HMAC-signed, `HttpOnly`, `SameSite=Lax` cookie (`Secure` behind `https://` `PUBLIC_URL`), valid 30
  days. Changing your password signs out every other session.
- **Tokens** (skill, extension): random `r42_…` values, shown once, stored only as SHA-256. Delete one on Settings to
  revoke it. A token only reads and writes notes and files (`/api/v1/*`, `/files/*`): it can't make more tokens, change
  the password or use `/admin`.
- **Login throttling**: per IP and email one failure a second and 10 in 10 minutes; per IP 100, per email 50 in 10
  minutes (high enough that a stranger can't lock you out). Accepting an invitation as an existing user uses the same
  budgets; changing your password allows 10 wrong current passwords in 10 minutes.
- **CSRF**: cookie-signed-in writes are refused unless the browser says they come from the same origin
  (`Sec-Fetch-Site`), on top of `SameSite=Lax`, so a sibling subdomain can't post to the API either.
- **Repositories** belong to an account; the same name can be connected in several accounts, and each only ever sees
  its own notes. Only owners and admins connect new ones (also by uploading).
- **Behind Cloudflare**: with `CLOUDFLARE_ONLY=1` the server answers only Cloudflare's addresses (the last
  `X-Forwarded-For` entry, added by the proxy in front, is checked against Cloudflare's ranges), so its own IP can't be
  used to skip Cloudflare. Without it, the client is that last entry; client-sent ones are ignored.
- **No third parties**: the page loads nothing from elsewhere (self-hosted font, CSP `'self'`), and note images load
  only from the note's server, so no outside service learns who opens the app or reads a note.
- **Quotas**: `MAX_ACCOUNT_MB` of files and `MAX_PULLS` PRs per account, so one leaked token can't fill the disk.

## Uploads

Only these files are accepted, checked by **content**, not just by name:

| Type | Check |
|---|---|
| `.png` `.jpg` `.jpeg` `.gif` `.webp` | the file starts with that image format's signature |
| `.md` `.csv` `.txt` `.html` | valid UTF-8, no NUL bytes |

Everything else (SVG, PDF, archives, video, executables) is refused with `415`. Limits: **1 MB per file**, 30 files
and 20 MB per PR, 500 notes of 20,000 characters. A refused upload changes nothing.

Files are served from `/files/<pull>/<name>` only after the same access check as the PR, with
`Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and text always as `text/plain` — an uploaded
file can never run as a page on your server's origin. The one exception is `.html` demos, below.

## HTML demos

An agent can attach a small `.html` file to show something interactive. It is untrusted code, so it only ever runs
inside a sandbox with an **opaque origin** (no `allow-same-origin`) and a CSP that blocks every request:

```
sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'
```

- **On GitHub, GitLab and Bitbucket** the extension never puts it in the site's page. It loads its own `demo.html`, a
  sandboxed extension page (manifest `sandbox`, same CSP plus `frame-src 'none'`), in an
  `<iframe sandbox="allow-scripts">`, posts the HTML into it, and runs it in a sandboxed `srcdoc` frame inside, which
  inherits the CSP. The demo
  cannot read GitHub's DOM, cookies or storage, cannot call the extension (no `chrome.runtime`), cannot navigate the
  tab, open popups or submit forms, and cannot load or send anything over the network.
- **In the web app** the server sends `.html` as `text/html` with the same CSP (plus `frame-ancestors 'self'`) only
  when it is loaded in a frame (`Sec-Fetch-Dest: iframe`), and the web app frames it with `sandbox="allow-scripts"`.
  Opened as a page of its own (a link, a new tab) it is served as plain-text source, so a demo can never pose as a
  page of your Reviews42 site.
- **No swapping itself for a live page**: a demo that navigates its own frame (`location = 'https://…'`, a meta
  refresh) is stopped by the parent's `frame-src` (the web app's page CSP, `'none'` in `demo.html`), so it can't load a
  remote page that would have the network.

What it can still do: run scripts and draw inside its own frame, and `postMessage` to its parent (which nothing in
Reviews42 listens to). Only members of the PR's account can see it, like every other note.

## Rendering

Notes are untrusted input. They are rendered by one small Markdown renderer
([`extension/markdown.js`](../extension/markdown.js)) used by both the web app and the extension: everything is
HTML-escaped first, only `http(s)` and relative URLs survive in links (not `//host` or `/\host`), images load only
from the note's own server (a remote image becomes a link, so no third party learns who read a note), and generated
tags are protected from later passes. Attached `.md` / `.csv` / `.txt` files go through the same escaping.

The extension holds tokens in its background worker; the sites' pages never see them. It fetches only
`/files/<pull>/<name>` paths from connected servers, connects only to `https://` servers (`http://` for localhost),
parses notes in an inert `<template>` so no image loads before its URL points at the right server, and its
`demo.html` is reachable only through a per-session URL (`use_dynamic_url`), so pages can't detect the extension.

## Secrets at rest

The S3 secret key is encrypted (AES-256-GCM) with `ENCRYPTION_KEY` or `DATA_DIR/encryption.key`, so a copy of the
database alone doesn't reveal it. Keep `/data` (or `ENCRYPTION_KEY`) with your backups.

## Headers

Every response carries `secureHeaders` (`X-Frame-Options`, HSTS, `Referrer-Policy: no-referrer`, …). The web app's
page adds a CSP: scripts, styles, fonts and images only from the server itself (the font is self-hosted), frames only
from the server (the sandboxed demos), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`. Server errors can be
reported to a Sentry-compatible DSN with the route pattern only, never the URL or body. An S3 error shows only the
bucket's error code, never its reply.

Found a problem? Please report it privately to the maintainer rather than in a public issue.
