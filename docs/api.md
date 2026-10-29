# API

← [README](../README.md)

Authenticate with a token from Settings: `authorization: Bearer dn_…`. The web app uses the same routes with its
session cookie. Tokens work only on `/api/v1/*`, `/files/*` and `/mcp`: they can't make tokens, change passwords or reach `/admin`.

| Method | Path | |
|---|---|---|
| `PUT` | `/api/v1/pulls/<repository>/<number>` | replace your notes and files on a PR (see below) |
| `GET` | `/api/v1/pulls/<repository>/<number>` | the PR's notes, summary and files; `404` when none or not your account's |
| `DELETE` | `/api/v1/pulls/<repository>/<number>` | delete your notes and files now (an owner or admin: everyone's) |
| `DELETE` | `/api/pulls/:id` | the same by PR id (web app's **delete notes**); the extension adds `?id=<pull id>` to the route above, `409` if the PR changed |
| `DELETE` | `/api/v1/annotations/:id` | remove one note (the extension's **remove note**); the PR and its files stay |
| `GET` | `/api/v1/me` | who the token belongs to |
| `DELETE` | `/api/v1/token` | delete the token this request carries (the extension's **Remove** for a token it got from Sign in and connect) |
| `POST` | `/api/v1/connect/token` | `{code, verifier, redirect_uri}`, no token: the extension trades a one-time code from `/connect` and its PKCE verifier for `{token, user}` ([extension](extension.md#how-sign-in-and-connect-works)) |
| `PUT` | `/api/repositories/:id/rules` | `{risk, deploy, screenshots}`: what every upload must carry (account admins, web app session) |
| `GET` | `/files/:pull/:name` | an uploaded file (same access as its PR) |
| `POST` | `/mcp` | the same notes for MCP clients (see [MCP](#mcp)); `GET` answers `405` |
| `GET` | `/skill/SKILL.md`, `/install.sh` | the agent skill, with this server's URL filled in |
| `GET` | `/skill/version` | the skill's version (the release plus a hash of the skill as this server serves it), which installed copies compare with their own |
| `GET` | `/healthz` | `ok` when the database answers (local callers only with `CLOUDFLARE_ONLY=1`) |

`<repository>` is `owner/name` on GitHub (`rails/rails`) and `host/path` on GitLab and Bitbucket:
`gitlab.com/group/sub/project`, `gitlab.acme.dev/team/app` (self-hosted), `bitbucket.org/team/app`. `<number>` is the
PR number, the merge request's `!iid` on GitLab.

## Upload

JSON body, or `multipart/form-data` with a `payload` field (JSON, or a JSON file) and any number of `file` fields:

```json
{
  "title": "PR title",
  "head_sha": "commit the notes were written for",
  "summary": "Markdown",
  "deploy": "Markdown, optional: what shipping it takes",
  "preview": "https://pr-42.shop.vercel.app",
  "stack": [{ "number": 41, "title": "Fee table" }, { "number": 42, "title": "Express picker" }],
  "annotations": [
    { "path": "app/a.ts", "line": 10, "end_line": 14, "side": "RIGHT", "code": "if (total <= 0) return", "title": "optional", "body": "Markdown", "risk": "high", "try": "/checkout" }
  ]
}
```

- `line` / `end_line`: new-side line numbers; `side: "LEFT"` for removed lines; no `line` = a note on the whole file.
- `code` (optional, with `line`): that line's text, whitespace collapsed (300 characters). When a later push moves the
  block, the extension finds the nearest line that reads so and puts the note there (*moved to line N*); no such line:
  *code changed since*.
- `risk` (optional): `high`, `medium` or `low`; anything else is dropped. The extension and the web app list risky notes first.
- `deploy` (optional): the deploy card, Markdown: migrations, new env vars, feature flags, the order of steps, how to
  roll back. Shown pinned at the top of the summary box and on the PR's page. List items starting with a kind
  (`- migration:`, `- env:`, `- flag:`, `- step:`, `- rollback:`) show that kind as a tag.
- `preview` (optional): the PR's preview deploy, an `https://` URL (anything else is dropped). A note's `try`, a path
  under the preview URL (`/checkout?step=2` opens `<preview>/checkout?step=2`, also when the preview has a path of its
  own; not `//host`, else dropped), becomes *try it on the preview ↗* under the note.
- `stack` (optional): for a stacked PR, every PR of the stack bottom first, this one included, `[{number, title}]`, at
  most 20; kept only with this PR and at least one other in it. `GET` adds `notes` per entry: that PR has notes in
  this account too.
- The repository's [rules](accounts.md#repository-rules) can require a risk on every note, a deploy card, or an image
  or video when a note is on certain paths; an upload that misses one gets `422` saying what to add.
- `attachment:<file name>` anywhere in `summary`, `deploy` or `body` becomes the uploaded file's URL.
- In `body` and `summary`: ` ```mermaid ` flowcharts are drawn as diagrams, and two adjacent images named
  `…-before` / `…-after` (or captioned Before / After) become one image with a drag handle. An image whose file is an
  `.mp4` or `.webm` (`![caption](attachment:flow.webm)`) plays inline as a muted video with controls.
  `[text](#note:<path>:<line>)` links to another note of the PR (the one whose lines hold `<line>`, the new side first;
  `#note:<path>` alone: the file's note, else its first); a click scrolls to it in the diff and on the PR's page.
- Every note and file has its author. Each PUT replaces the caller's own notes and files on the PR (teammates' stay)
  and restarts the expiry. Title, `head_sha`, summary, deploy card, preview and stack are the PR's: the latest upload sets them, and
  while teammates' notes are there a blank one keeps what it was. Limits per PR (`MAX_ANNOTATIONS`, `MAX_FILES`) count
  everyone's notes and files.
- A repository is looked up in the uploader's accounts (the same name can be connected in several accounts). Not
  connected in any of them: it is connected to the account the uploader owns or administers; a member gets `403`.
- Files: up to `MAX_FILE_MB` each (1 MB), `.mp4` / `.webm` recordings up to `MAX_VIDEO_MB` (2 MB), `MAX_FILES` files
  (30) and `MAX_PULL_MB` (20 MB) per request; a JSON body up to `MAX_BODY_KB` (1024). Defaults in brackets, see [install](install.md).
- Account limits: `MAX_PULLS` live PRs and `MAX_ACCOUNT_MB` of files (see [install](install.md)); over them, `413`.
  Less than `MIN_FREE_DISK_MB` free on the server's volume: `507` (an empty upload, which only removes yours, still passes). A multipart `payload` is held to `MAX_BODY_KB` like a JSON body.

`GET` returns the stored notes with their `id`, `risk`, `mine` (yours: what your next upload replaces) and `can_delete`,
the files with `mine` too, plus the PR's `can_delete` (anything of it you may remove), `can_delete_all` and `authors` (who wrote its notes and files, the last uploader first: `{name, avatar}`, `avatar` a URL on this server for people who sign in with GitHub, else `null`). A note is removed by its author or an
account owner or admin; `DELETE` of the PR removes everything for an owner or admin, your own notes and files for anyone
else (the PR goes with the last of them; `403` with none of yours).

Response: `{"id", "url", "annotations", "files"}`. Errors: `400` bad payload, `401` bad token, `403` repository not
connected and you're only a member, `413` too many / too big / account full, `415` file type not allowed (see [security](security.md)), `422` the
repository's rules ask for more (the message lists it).

```bash
curl -sS --fail-with-body -X PUT "$DIFFNOTES_URL/api/v1/pulls/acme/shop/42" -H "authorization: Bearer $DIFFNOTES_TOKEN" \
  -F payload=@diffnotes.json -F file=@after.png
```

## MCP

`POST /mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) (Streamable HTTP, stateless: one
JSON-RPC 2.0 message per request, a JSON reply; no sessions, no SSE stream), so an MCP client can annotate PRs without
the skill. Authenticate with the same `Bearer` token; a session cookie is not accepted, and a request whose `Origin` is
another site gets `403`. Methods: `initialize`, `notifications/initialized` (`202`, no body), `ping`, `tools/list`, `tools/call`.

| Tool | Arguments | Does |
|---|---|---|
| `get_notes` | `repo`, `number` | the `GET` above |
| `upload_notes` | `repo`, `number`, `payload` (the upload JSON above), `files`: `[{"name", "base64"}]` | the `PUT` above: same checks and limits, `attachment:<name>` links |
| `delete_notes` | `repo`, `number` | the `DELETE` above |

`repo` is the `<repository>` above (a PR URL or clone address works too). A refusal (`404`, `403`, `413`, `415`…) comes
back as a tool result with `isError: true` and the same message. The whole request may be up to `MAX_PULL_MB` × 4/3
(base64) plus `MAX_BODY_KB`; `payload` alone up to `MAX_BODY_KB`.

```bash
# Claude Code
claude mcp add --transport http diffnotes https://reviews.example.com/mcp --header "Authorization: Bearer $DIFFNOTES_TOKEN"
```

Cursor, `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{ "mcpServers": { "diffnotes": { "url": "https://reviews.example.com/mcp", "headers": { "Authorization": "Bearer ${env:DIFFNOTES_TOKEN}" } } } }
```

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.diffnotes]
url = "https://reviews.example.com/mcp"
bearer_token_env_var = "DIFFNOTES_TOKEN"
```

```bash
curl -s "$DIFFNOTES_URL/mcp" -H "authorization: Bearer $DIFFNOTES_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_notes","arguments":{"repo":"acme/shop","number":42}}}'
```
