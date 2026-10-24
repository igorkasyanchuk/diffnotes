# API

← [README](../README.md)

Authenticate with a token from Settings: `authorization: Bearer r42_…`. The web app uses the same routes with its
session cookie. Tokens work only on `/api/v1/*` and `/files/*`: they can't make tokens, change passwords or reach `/admin`.

| Method | Path | |
|---|---|---|
| `PUT` | `/api/v1/pulls/<repository>/<number>` | replace a PR's notes and files (see below) |
| `GET` | `/api/v1/pulls/<repository>/<number>` | the PR's notes, summary and files; `404` when none or not your account's |
| `DELETE` | `/api/v1/pulls/<repository>/<number>` | delete the notes and files now |
| `DELETE` | `/api/pulls/:id` | the same by PR id (web app's **delete notes**); the extension adds `?id=<pull id>` to the route above, `409` if the PR changed |
| `DELETE` | `/api/v1/annotations/:id` | remove one note (the extension's **remove note**); the PR and its files stay |
| `GET` | `/api/v1/me` | who the token belongs to |
| `GET` | `/files/:pull/:name` | an uploaded file (same access as its PR) |
| `GET` | `/skill/SKILL.md`, `/install.sh` | the agent skill, with this server's URL filled in |
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
  "annotations": [
    { "path": "app/a.ts", "line": 10, "end_line": 14, "side": "RIGHT", "title": "optional", "body": "Markdown", "risk": "high" }
  ]
}
```

- `line` / `end_line`: new-side line numbers; `side: "LEFT"` for removed lines; no `line` = a note on the whole file.
- `risk` (optional): `high`, `medium` or `low`; anything else is dropped. The extension and the web app list risky notes first.
- `attachment:<file name>` anywhere in `summary` or `body` becomes the uploaded file's URL.
- In `body` and `summary`: ` ```mermaid ` flowcharts are drawn as diagrams, and two adjacent images named
  `…-before` / `…-after` (or captioned Before / After) become one image with a drag handle.
- Each PUT replaces the previous notes and files and restarts the expiry.
- A repository is looked up in the uploader's accounts (the same name can be connected in several accounts). Not
  connected in any of them: it is connected to the account the uploader owns or administers; a member gets `403`.
- Account limits: `MAX_PULLS` live PRs and `MAX_ACCOUNT_MB` of files (see [install](install.md)); over them, `413`.

`GET` returns the stored notes with their `id` and `risk`, plus `can_delete`: whether you may remove them. Removing
(one note or all) is for the PR's uploader and the account's owner and admins; other members get `403`.

Response: `{"id", "url", "annotations", "files"}`. Errors: `400` bad payload, `401` bad token, `403` repository not
connected and you're only a member, `413` too many / too big / account full, `415` file type not allowed (see [security](security.md)).

```bash
curl -fsS -X PUT "$REVIEWS42_URL/api/v1/pulls/acme/shop/42" -H "authorization: Bearer $REVIEWS42_TOKEN" \
  -F payload=@reviews42.json -F file=@after.png
```
