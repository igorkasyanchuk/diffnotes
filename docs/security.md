# Security

← [README](../README.md)

## Access

- **Invite-only.** The first admin is created on first boot; everyone else needs an invitation link (7 days, one use).
- **Per account.** A PR's notes and files are visible only to members of the account that owns its repository (and
  super admins). Other users get `404`, so they can't even tell a PR is annotated.
- **Sessions**: an HMAC-signed, `HttpOnly`, `SameSite=Lax` cookie (`Secure` behind `https://` `PUBLIC_URL`), valid 30
  days. Changing your password signs out every other session.
- **Tokens** (skill, extension): random `r42_…` values, shown once, stored only as SHA-256. Delete one on Settings to
  revoke it.
- **Login throttling**: one failed attempt per second per IP and email, at most 20 failures per email in 10 minutes;
  accepting an invitation as an existing user uses the same budget.

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

- **On GitHub** the extension never puts it in github.com's page. It loads its own `demo.html`, a sandboxed extension
  page (manifest `sandbox`, same CSP), in an `<iframe sandbox="allow-scripts">` and posts the HTML into it. The demo
  cannot read GitHub's DOM, cookies or storage, cannot call the extension (no `chrome.runtime`), cannot navigate the
  tab, open popups or submit forms, and cannot load or send anything over the network.
- **In the web app** the server sends `.html` as `text/html` with the same CSP (plus `frame-ancestors 'self'`) only
  when it is loaded in a frame (`Sec-Fetch-Dest: iframe`), and the web app frames it with `sandbox="allow-scripts"`.
  Opened as a page of its own (a link, a new tab) it is served as plain-text source, so a demo can never pose as a
  page of your Reviews42 site.

What it can still do: run scripts and draw inside its own frame, `postMessage` to the frame's parent (which nothing in
Reviews42 listens to), and navigate its own frame (CSP has no control over navigation; there is nothing in the frame
for it to carry away but what someone types into the demo). Only members of the PR's account can see it, like every
other note.

## Rendering

Notes are untrusted input. They are rendered by one small Markdown renderer
([`extension/markdown.js`](../extension/markdown.js)) used by both the web app and the extension: everything is
HTML-escaped first, only `http(s)` and relative URLs survive in links and images, and generated tags are protected
from later passes. Attached `.md` / `.csv` / `.txt` files go through the same escaping.

The extension holds tokens in its background worker; github.com pages never see them. It fetches only
`/files/<pull>/<name>` paths from connected servers.

## Secrets at rest

The S3 secret key is encrypted (AES-256-GCM) with `ENCRYPTION_KEY` or `DATA_DIR/encryption.key`, so a copy of the
database alone doesn't reveal it. Keep `/data` (or `ENCRYPTION_KEY`) with your backups.

## Headers

Every response carries `secureHeaders` (`X-Frame-Options`, HSTS, `Referrer-Policy: no-referrer`, …). Server errors can
be reported to a Sentry-compatible DSN with the route pattern only, never the URL or body.

Found a problem? Please report it privately to the maintainer rather than in a public issue.
