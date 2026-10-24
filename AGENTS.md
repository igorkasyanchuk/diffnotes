# Reviews42

See README.md for what it is. Same stack and habits as specdrop.

## Stack

- Server: Node 24 + Hono, built-in `node:sqlite`, `.ts` run directly through type stripping (no build step):
  relative imports need `.ts`, `import type` for types, no `enum` / `namespace` / parameter properties.
- Web: Vite + React 19, no router lib (`web/main.tsx` switches on `location.pathname`), plain CSS tokens in `web/styles.css`.
- Extension: Chrome MV3, plain JS, no build. `extension/markdown.js` is the one Markdown renderer, also imported by the web app.

## Layout

```
server/db.ts      schema, password hashing, bootstrap (first admin + account), tokens, purgeExpired
server/app.ts     all routes: auth, invites, accounts, repos, tokens, /api/v1 pulls (skill + extension), /files, /install.sh
server/index.ts   start, hourly purge, SIGTERM
web/main.tsx      landing, login, invite, dashboard, account, pull preview, settings
skill/reviews42/  the agent skill, served at /skill/SKILL.md with {{HOST}} filled in
extension/        manifest, background (holds the token, fetches), content (draws on github.com), popup (connect)
```

## Rules

- Keep it small: few files, no dependency for what a few lines do. Mark deliberate shortcuts with `// ponytail:`.
- Access: everything about a PR is visible only to members of the account that owns its repository; other
  accounts' rows answer 404. Tokens are stored as sha256 only.
- Annotation Markdown is untrusted: render it only through `r42Markdown` (escapes everything, keeps http(s) and relative URLs).
- `/files/*` is served with `CSP: sandbox` + `nosniff`.
- GitHub's diff DOM: `extension/content.js` supports the React changes view (`h3[class*=file-name]`, `td[data-diff-side][data-line-number]`)
  and the classic one (`.file-header[data-path]`, `td.blob-num`). If notes stop appearing, re-check those selectors first.

## Commands

```bash
npm test          # vitest, server/app.test.ts is one sequential story
npm run typecheck
npm run build
```
