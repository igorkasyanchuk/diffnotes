---
name: reviews42
description: Annotate a GitHub pull request for its reviewers by uploading plain-language notes (per file and per changed line range), screenshots and files to Reviews42; teammates then see them inside GitHub's changes view through the Reviews42 browser extension. Use when asked to annotate, explain, walk through or "add notes / screenshots to" a PR, or to upload annotations to Reviews42. Nothing is posted to GitHub itself.
---

# Reviews42: annotate a pull request

You explain a pull request to the people who will review it. You upload the notes to the Reviews42 server
(`{{HOST}}`); the Reviews42 browser extension draws them next to the diff on GitHub for everyone in the
account that owns the repository. Notes expire on their own after the server's retention period.

## Setup (once per machine)

```bash
echo "${REVIEWS42_URL:-{{HOST}}}" && test -n "$REVIEWS42_TOKEN" && echo token set || echo "no REVIEWS42_TOKEN"
```

No token? Stop and tell the user to make one at `{{HOST}}/settings` and add
`export REVIEWS42_URL={{HOST}}` and `export REVIEWS42_TOKEN=…` to their shell profile. Never print the token,
never write it into files or commits.

## Rules

- **Never touch the code or the PR to explain it.** No code comments, no PR comments, no PR body edits.
- **Skip tests and generated files**: `spec/`, `test/`, `__tests__/`, `*_spec.*`, `*.test.*`, `*.spec.*`, fixtures,
  factories, snapshots, lock files, `dist/`, `vendor/`.
- **Words**: one to three short sentences per note, plain words a non-author understands. Say what it does for the
  user or the system and why it is needed, not how the code reads. "moved, unchanged" for pure moves.
- **One note per changed block** (a run of consecutive added/removed lines), anchored to the block's first line.
  Removed-only blocks get a note on the old side (`"side": "LEFT"`, old line number).
- **New, renamed or deleted files get one file note** (no `line`), not per-line notes.
- **Screenshots and files are welcome** when they show the change better than words. Reference each upload in a
  note's Markdown as `attachment:<file name>`:
  - images: `![Checkout on mobile](attachment:checkout-mobile.png)`. Put **several images in one note** when they belong
    together, e.g. a component at mobile and desktop width, or before and after: reviewers flip through them in a gallery
    with the arrow keys. The alt text is the caption, so make it say what the image shows.
  - reports and data: `[test report](attachment:report.md)`, `[timings](attachment:bench.csv)`, `[log](attachment:out.txt)`;
    they open as a rendered preview (Markdown, a CSV table, plain text).
- **Allowed files**: `.png .jpg .jpeg .gif .webp` (real images, checked by content), `.md .csv .txt` (UTF-8 text).
  Up to **1 MB each**, 30 files and 20 MB per PR. Anything else (svg, html, pdf, zip, video) is refused with `415`:
  convert it first (a PNG screenshot instead of an SVG, a Markdown summary instead of a PDF). Keep screenshots small:
  crop to the part that changed, PNG for UI, JPG for photos.
- Markdown in `body` and `summary`: headings, paragraphs, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, lists and
  `- [x]` task lists, `>` quotes, fenced code, tables, `---`, `[links](https://…)` and images. Long notes are cut with a
  "show more" toggle, so put the point in the first two lines.

## Workflow

1. **Find the PR.** In the PR's worktree:
   ```bash
   gh pr view --json number,title,headRefOid,url,baseRefName   # or ask the user for the PR URL
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)  # owner/name
   ```
2. **Read the change from git, not from memory.**
   ```bash
   BASE=$(git merge-base origin/<baseRefName> HEAD)
   git diff $BASE HEAD --name-status                          # A = new, M = edited, R = renamed, D = deleted
   git diff $BASE HEAD -U0 -- . ':!spec' ':!test' ':!*.test.*' # each hunk header @@ -old,n +new,m @@ ≈ one block
   ```
   For an edited block, `line` is the first new line (`+new` in the hunk header) and `end_line` the last
   (`new + m - 1`); for a removed-only block use `"side": "LEFT"` and the old numbers.
3. **Screenshots** (optional): when the change is visible in a UI and you can run it, take before/after shots
   with whatever browser tool you have and save them next to the payload. For responsive UI, shoot the same screen at
   mobile (~390px) and desktop (~1280px) width and put both in one note.
4. **Write `reviews42.json`** (outside the repo, e.g. in a temp dir):
   ```json
   {
     "title": "PR title",
     "head_sha": "<headRefOid>",
     "summary": "Two or three sentences: what this PR does and why. ![after](attachment:after.png)",
     "annotations": [
       { "path": "app/models/invite.rb", "body": "New: an invitation a teammate opens to join the team." },
       { "path": "app/controllers/sessions_controller.rb", "line": 14, "end_line": 22,
         "title": "Login by invitation", "body": "Only people with an invitation can sign up now." },
       { "path": "config/routes.rb", "line": 8, "side": "LEFT", "body": "The old public sign-up page, removed." }
     ]
   }
   ```
   `path` exactly as in the diff; `title` optional; up to 500 annotations.
5. **Upload** (replaces anything uploaded for this PR before, so re-running after a push is safe):
   ```bash
   H=${REVIEWS42_URL:-{{HOST}}}
   curl -fsS -X PUT "$H/api/v1/pulls/$REPO/<number>" -H "authorization: Bearer $REVIEWS42_TOKEN" \
     -F payload=@reviews42.json -F file=@after.png -F file=@before.png
   # JSON only, no files: -H 'content-type: application/json' --data-binary @reviews42.json
   # → {"id":"…","url":"…/pulls/<id>","annotations":3,"files":2}
   ```
   `404` = the repository belongs to an account you are not in; `401` = bad token; `413` = too many or too big files;
   `415` = a file type that isn't allowed or doesn't match its extension. A new repository is connected to your account on
   its first upload.
6. **Check it**: `curl -fsS "$H/api/v1/pulls/$REPO/<number>" -H "authorization: Bearer $REVIEWS42_TOKEN"` returns what
   was stored; the `annotations` count must match what you wrote.

## Report back

Say how many file notes and line notes you uploaded (and that test files were skipped), list the attached files,
and give the `url` from the upload response plus `https://github.com/<REPO>/pull/<number>/changes`, where teammates
with the extension see the notes.
