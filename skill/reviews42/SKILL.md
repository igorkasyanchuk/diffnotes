---
name: reviews42
description: Annotate a pull request (GitHub, GitLab merge request or Bitbucket) for its reviewers by uploading plain-language notes (per file and per changed line range), screenshots, files and small HTML demos to Reviews42; teammates then see them inside the diff through the Reviews42 browser extension. Use when asked to annotate, explain, walk through or "add notes / screenshots to" a PR or MR, to upload annotations to Reviews42, or to refresh or remove notes that are out of date after new commits. Nothing is posted to GitHub, GitLab or Bitbucket itself.
---

# Reviews42: annotate a pull request

You explain a pull request to the people who will review it. You upload the notes to the Reviews42 server
(`{{HOST}}`); the Reviews42 browser extension draws them next to the diff on GitHub, GitLab (merge requests) or
Bitbucket for everyone in the account that owns the repository. Notes expire on their own after the server's retention period.

## Setup (once per machine)

```bash
echo "${REVIEWS42_URL:-{{HOST}}}" && test -n "$REVIEWS42_TOKEN" && echo token set || echo "no REVIEWS42_TOKEN"
```

No token? Stop and tell the user to make one at `{{HOST}}/settings` and add
`export REVIEWS42_URL={{HOST}}` and `export REVIEWS42_TOKEN=…` to their shell profile. Never print the token,
never write it into files or commits.

## Rules

- **Never touch the code or the PR to explain it.** No code comments, no PR comments, no PR body edits.
- **Only upload what you are sure is true at the PR's head.** Annotate committed and pushed code only: `head_sha` is
  the PR's head commit and equals `git rev-parse HEAD`. Every note points at a block that is in the current diff
  (step 5 checks it) and says what that code does now. A wrong note is worse than none: when unsure, leave it out.
- **Skip tests and generated files**: `spec/`, `test/`, `__tests__/`, `*_spec.*`, `*.test.*`, `*.spec.*`, fixtures,
  factories, snapshots, lock files, `dist/`, `vendor/`.
- **Words**: one to three short sentences per note, plain words a non-author understands. Say what it does for the
  user or the system and why it is needed, not how the code reads. "moved, unchanged" for pure moves.
- **One note per changed block** (a run of consecutive added/removed lines), anchored to the block's first line.
  Removed-only blocks get a note on the old side (`"side": "LEFT"`, old line number).
- **New, renamed or deleted files get one file note** (no `line`), not per-line notes.
- **Screenshots and files are welcome** when they show the change better than words. Reference each upload in a
  note's Markdown as `attachment:<file name>`:
  - images: `![Checkout on mobile](attachment:checkout-mobile.png)` (upload them: an image from another site shows as a link). Put **several images in one note** when they belong
    together, e.g. a component at mobile and desktop width, or before and after: reviewers flip through them in a gallery
    with the arrow keys. The alt text is the caption, so make it say what the image shows.
  - reports and data: `[test report](attachment:report.md)`, `[timings](attachment:bench.csv)`, `[log](attachment:out.txt)`;
    they open as a rendered preview (Markdown, a CSV table, plain text).
  - before / after: two images next to each other in one note, named `…-before.png` / `…-after.png` (or alt text
    starting with "Before" / "After"), become one image with a drag handle: `![Before: grey button](attachment:login-before.png) ![After: orange button](attachment:login-after.png)`.
    Same size and crop for both, so the handle lines them up.
  - interactive demos: `[try the picker](attachment:picker-demo.html)` when clicking beats a screenshot (a component's
    states, an animation, a form's validation). Reviewers get a live preview under the note and can expand it at phone,
    tablet or desktop width. Write **one self-contained file**: CSS in `<style>`, JS in `<script>`, images as `data:`
    URIs, fake data inline. It runs in a locked sandbox: **no network at all** (no CDN scripts, fonts, `fetch`, external
    images), no cookies or storage, no popups or `alert()`, and `<form>` submission is blocked (use click
    handlers). Keep it small and focused on the change.
- **Diagrams**: a fenced ` ```mermaid ` block with a `flowchart LR` or `flowchart TD` (also `graph`) is drawn as a
  diagram: nodes `A[box]`, `A(round)`, `A{decision}`, `A((circle))`, edges `-->`, `---`, `-.->`, `==>`, labels
  `-->|yes|`. Use it for a flow or a state change that words make hard to follow; keep it under ~15 nodes. Other
  Mermaid types (sequence, class…) show as code.
- **Risk**: give `"risk": "high" | "medium" | "low"` to the notes where reviewers should look hardest or can relax
  (money, auth, data loss, migrations, concurrency are high; copy and renames low). Reviewers get a "where to look
  hardest" list at the top. Use it sparingly and say why in the note's text; leave it out when there is nothing to flag.
- **Allowed files**: `.png .jpg .jpeg .gif .webp` (real images, checked by content), `.md .csv .txt .html` (UTF-8 text).
  Up to **1 MB each**, 30 files and 20 MB per PR. Anything else (svg, pdf, zip, video) is refused with `415`:
  convert it first (a PNG screenshot instead of an SVG, a Markdown summary instead of a PDF). Keep screenshots small:
  crop to the part that changed, PNG for UI, JPG for photos.
- Markdown in `body` and `summary`: headings, paragraphs, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, lists and
  `- [x]` task lists, `>` quotes, fenced code, tables, `---`, `[links](https://…)` and images. Long notes are cut with a
  "show more" toggle, so put the point in the first two lines.

## Workflow

1. **Find the PR and name the repository** the way Reviews42 does: `owner/name` on GitHub, `host/path` on GitLab and
   Bitbucket (`gitlab.com/group/sub/project`, `gitlab.acme.dev/team/app` for self-hosted GitLab, `bitbucket.org/team/app`).
   ```bash
   git remote get-url origin   # tells you the host
   # GitHub
   gh pr view --json number,title,headRefOid,url,baseRefName
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)                        # owner/name
   # GitLab (glab, or ask for the MR URL: …/-/merge_requests/<number>); the number is the MR's !iid
   glab mr view --output json   # iid, title, sha, target_branch
   # Bitbucket: ask for the PR URL (bitbucket.org/<team>/<repo>/pull-requests/<number>)
   # GitLab and Bitbucket: host/path from the remote (ssh or https, any port of an ssh remote dropped)
   REPO=$(git remote get-url origin | sed -E 's#^git@([^:]+):#\1/#; s#^ssh://([^@/]+@)?([^:/]+)(:[0-9]+)?/#\2/#; s#^https?://([^@/]+@)?##; s#\.git$##')
   ```
   A full URL also works as `$REPO` once its `https://` is dropped. Ask the user for the number if no CLI tells you.
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
       { "path": "app/controllers/sessions_controller.rb", "line": 14, "end_line": 22, "risk": "high",
         "title": "Login by invitation", "body": "Only people with an invitation can sign up now; this is the sign-up gate." },
       { "path": "config/routes.rb", "line": 8, "side": "LEFT", "body": "The old public sign-up page, removed." }
     ]
   }
   ```
   `path` exactly as in the diff; `title` optional; up to 500 annotations.
5. **Check every note against the diff before uploading**; fix or drop each one it reports, then run it again until
   it prints `ok`:
   ```bash
   test "$(git rev-parse HEAD)" = "<headRefOid>" || echo "HEAD is not the PR head: push, or check out the PR branch"
   python3 check.py reviews42.json "$BASE"   # check.py: the script under “Check script” below
   ```
   It only proves the places exist; you still reread each note against the code at those lines.
6. **Upload** (replaces everything uploaded for this PR before: notes you leave out are deleted, so always send the
   full, current set):
   ```bash
   H=${REVIEWS42_URL:-{{HOST}}}
   curl -fsS -X PUT "$H/api/v1/pulls/$REPO/<number>" -H "authorization: Bearer $REVIEWS42_TOKEN" \
     -F payload=@reviews42.json -F file=@after.png -F file=@before.png
   # JSON only, no files: -H 'content-type: application/json' --data-binary @reviews42.json
   # → {"id":"…","url":"…/pulls/<id>","annotations":3,"files":2}
   ```
   `401` = bad token; `403` = the repository isn't connected to your account and you are only a member there (ask an
   account admin to connect it); `413` = too many or too big files, or the account is full; `415` = a file type that
   isn't allowed or doesn't match its extension. A new repository is connected to the account you own or administer on
   its first upload.
7. **Check it**: `curl -fsS "$H/api/v1/pulls/$REPO/<number>" -H "authorization: Bearer $REVIEWS42_TOKEN"` returns what
   was stored; the `annotations` count must match what you wrote.

## After new commits: keep the notes true

Old notes go stale when the code under them changes: lines move, blocks disappear, behaviour changes. Whenever you
push to an annotated PR (or are asked to refresh its notes):

1. Fetch what is stored: `curl -fsS "$H/api/v1/pulls/$REPO/<number>" -H "authorization: Bearer $REVIEWS42_TOKEN" > old.json`
   (`404` = nothing stored yet).
2. Read the new diff (workflow step 2) and go through every stored note: keep it only if its file is still changed,
   its block still exists (fix moved line numbers) and its words still describe the code. Rewrite what changed,
   drop what no longer applies, add notes for new blocks. Keep the attachments that still show the current state
   (re-upload them with the payload; old files are replaced too).
3. Run the check (step 5) and upload the full set (step 6). Notes you drop disappear for reviewers right away.

**Remove all notes** of a PR when none of them holds any more and you have nothing new to say, when the PR is closed
without merging, or when the user asks:

```bash
curl -fsS -X DELETE "$H/api/v1/pulls/$REPO/<number>" -H "authorization: Bearer $REVIEWS42_TOKEN"   # → {"ok":true}
```

`403` = a teammate uploaded these notes and you are only a member: ask them or an account admin to remove them.

The PR's uploader and account admins can also remove single notes or all of them right in the diff (**remove note**,
**remove all notes**) or with **delete notes** on the PR's page in Reviews42; a re-run must not bring removed notes
back unless they are true again.

## Check script

Save as `check.py` next to `reviews42.json` (outside the repo). Exit code 1 lists every note whose file is not in
the PR's diff or whose lines are not inside one changed block on its side.

```python
import json, re, subprocess, sys
pay, base = json.load(open(sys.argv[1])), sys.argv[2]
diff = subprocess.run(['git', 'diff', '-M', '-U0', '--no-color', base, 'HEAD'], capture_output=True, text=True, check=True).stdout
files, old, new = {}, None, None
for l in diff.splitlines():
    if l.startswith('--- '): old = None if l == '--- /dev/null' else l[6:]
    elif l.startswith('+++ '):
        new = None if l == '+++ /dev/null' else l[6:]
        files[new or old] = {'LEFT': [], 'RIGHT': []}
    elif (m := re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', l)):
        o, oc, n, nc = int(m[1]), int(m[2] or 1), int(m[3]), int(m[4] or 1)
        if oc: files[new or old]['LEFT'].append((o, o + oc - 1))
        if nc: files[new or old]['RIGHT'].append((n, n + nc - 1))
bad = []
for i, a in enumerate(pay.get('annotations', [])):
    f, line = files.get(a.get('path')), a.get('line')
    end = a.get('end_line') or line
    if f is None: bad.append(f"annotations[{i}] {a.get('path')}: not changed in this PR")
    elif line and not any(s <= line and end <= e for s, e in f[a.get('side', 'RIGHT')]):
        bad.append(f"annotations[{i}] {a['path']}:{line}-{end}: not inside one changed block ({a.get('side', 'RIGHT')})")
print('\n'.join(bad) or 'ok'); sys.exit(1 if bad else 0)
```

## Report back

Say how many file notes and line notes you uploaded (and that test files were skipped), on a refresh how many you kept,
rewrote and dropped, list the attached files,
and give the `url` from the upload response plus the diff page where teammates with the extension see the notes:
`https://github.com/<REPO>/pull/<number>/changes`, `https://<REPO>/-/merge_requests/<number>/diffs` (GitLab) or
`https://<REPO>/pull-requests/<number>/diff` (Bitbucket).
