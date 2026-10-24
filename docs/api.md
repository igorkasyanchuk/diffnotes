# API

← [README](../README.md)

Authenticate with a token from Settings: `authorization: Bearer r42_…`. The web app uses the same routes with its
session cookie.

| Method | Path | |
|---|---|---|
| `PUT` | `/api/v1/pulls/<repository>/<number>` | replace a PR's notes and files (see below) |
| `GET` | `/api/v1/pulls/<repository>/<number>` | the PR's notes, summary and files; `404` when none or not your account's |
| `DELETE` | `/api/v1/pulls/<repository>/<number>` | delete the notes and files now |
| `GET` | `/api/v1/me` | who the token belongs to |
| `GET` | `/files/:pull/:name` | an uploaded file (same access as its PR) |
| `GET` | `/skill/SKILL.md`, `/install.sh` | the agent skill, with this server's URL filled in |
| `GET` | `/healthz` | `ok` when the database answers |

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
    { "path": "app/a.ts", "line": 10, "end_line": 14, "side": "RIGHT", "title": "optional", "body": "Markdown" }
  ]
}
```

- `line` / `end_line`: new-side line numbers; `side: "LEFT"` for removed lines; no `line` = a note on the whole file.
- `attachment:<file name>` anywhere in `summary` or `body` becomes the uploaded file's URL.
- Each PUT replaces the previous notes and files and restarts the expiry.
- An unknown repository is connected to the uploader's account.

Response: `{"id", "url", "annotations", "files"}`. Errors: `400` bad payload, `401` bad token, `404` repository of another
account, `413` too many / too big, `415` file type not allowed (see [security](security.md)).

```bash
curl -fsS -X PUT "$REVIEWS42_URL/api/v1/pulls/acme/shop/42" -H "authorization: Bearer $REVIEWS42_TOKEN" \
  -F payload=@reviews42.json -F file=@after.png
```
