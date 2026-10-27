# Agent skill

← [README](../README.md)

The skill teaches a coding agent to explain a pull request to its reviewers and upload that explanation to DiffNotes.
It works with **Claude Code**, **Codex**, **Cursor** and other tools that read Agent Skills. The full text the agent
reads is [`skill/diffnotes/SKILL.md`](../skill/diffnotes/SKILL.md), also served by your server at `/skill/SKILL.md`.

## Install

```bash
curl -fsSL https://reviews.example.com/install.sh | sh
```

It writes the skill to `~/.claude/skills/diffnotes`, `~/.agents/skills/diffnotes` and, when Cursor is installed,
`~/.cursor/skills/diffnotes`. Then make a token on **Settings** (the app shows a bar until you have one) and add it to
your shell profile:

```bash
export DIFFNOTES_URL=https://reviews.example.com
export DIFFNOTES_TOKEN=dn_…
```

Run the install again to update the skill. It also removes a copy installed under the old name, `reviews42`; that one read
`REVIEWS42_URL` / `REVIEWS42_TOKEN`, so rename them to `DIFFNOTES_URL` / `DIFFNOTES_TOKEN` (old `r42_…` tokens keep working).

## Use

Open the PR's branch in your agent and ask: **“annotate this PR with diffnotes”**. The agent:

1. finds the PR (`gh pr view`) and reads the change **from git**, not from memory;
2. writes one short note per changed block, a card per new/renamed/deleted file, and a summary; tests and generated files are skipped;
3. adds screenshots when the change is visible (for responsive UI: the same screen at mobile and desktop width, in one note → a gallery);
4. uploads everything in one request and reports the link.

Re-running after a push replaces your previous notes and files (teammates' stay), so it is safe to repeat. Before every upload the agent
checks each note against the current diff (a small script in the skill: the file must be changed in the PR and the
lines inside one changed block) and only uploads what is true at the PR's head commit. After new commits it reads the
stored notes, keeps and fixes the ones that still hold and drops the rest; with nothing left to say it deletes them
(`DELETE /api/v1/pulls/…`; with an admin's token and teammates' notes on the PR, it uploads an empty set instead, so
theirs stay). People can delete their notes on a PR from its page (admins: all of them), and a note's author or an admin can remove
it right in the diff. Notes can also carry a risk level (a "where to look hardest" list for reviewers), before /
after image pairs (shown with a drag handle), short screen recordings, Mermaid flowcharts (drawn as diagrams) and
links to each other (`#note:path:line`).
When shipping the PR takes more than a merge (a migration, a new env var, a flag, steps in order), the agent adds a
**deploy card**, pinned at the top of the summary. A repository's [rules](accounts.md#repository-rules) can require
a risk on every note, a deploy card or screenshots; the agent adds what an upload is refused for and sends it again.
With a preview deploy (Vercel, Netlify, Render…, found from the PR's GitHub deployments), notes on visible changes get
*try it on the preview ↗* at the right path; a stacked PR shows its stack, bottom first, with this one highlighted.

### `.diffnotes.yml`

Put how your team wants PRs annotated next to the code, so it is reviewed in PRs like the code (the skill reads it
from the PR's base branch, so a PR can't loosen the rules for itself; every key is optional):

```yaml
language: en              # notes, titles, summary and deploy card in this language
tone: short, no jargon
skip: [docs/**, "*.snap"] # never annotated (tests and generated files never are)
screenshots: [web/**]     # a visible change here gets a screenshot or recording
risk: required            # every note rates its risk
deploy: required          # always a deploy card
summary: What it does for the user first, then why.
notes: Call it a basket, never a cart.
```

It shapes how the agent writes; it can't make it run commands or skip the skill's own rules (no secrets, only what is
true at the head). To *enforce* rules on every upload, whoever the agent is, set the server's
[repository rules](accounts.md#repository-rules) too.

## What a note looks like

````json
{
  "title": "Express shipping at checkout",
  "head_sha": "4f2c…",
  "summary": "Adds an express option. Empty carts stop early. See the [test report](attachment:report.md).",
  "deploy": "- migration: `add_express_fee`, reversible\n- env: `EXPRESS_FEE=499`\n- rollback: unset it; the option hides, no data is lost",
  "preview": "https://pr-42.shop.vercel.app",
  "annotations": [
    { "path": "app/checkout.ts", "line": 43, "end_line": 45, "title": "Charge the express fee", "try": "/checkout",
      "body": "Empty carts used to reach the payment provider with 0; now they return early.\n\n![Checkout on mobile](attachment:mobile.png) ![Checkout on desktop](attachment:desktop.png)" },
    { "path": "app/express.ts", "body": "New: the express fee and its label." },
    { "path": "app/old_rates.ts", "line": 8, "side": "LEFT", "body": "Old flat rate, removed." }
  ]
}
````

`line`/`end_line` are new-side line numbers (`side: "LEFT"` for removed lines); no `line` means a file-level card.
Bodies are Markdown: headings, lists, task lists, tables, quotes, code, links and images (uploaded ones: an image from
another site shows as a link). Long notes are cut with
*show more*, so the point goes first.

```bash
curl -sS --fail-with-body -X PUT "$DIFFNOTES_URL/api/v1/pulls/acme/shop/42" -H "authorization: Bearer $DIFFNOTES_TOKEN" \
  -F payload=@diffnotes.json -F file=@mobile.png -F file=@desktop.png -F file=@report.md
```

## Files

| Allowed | Checked | Shown as |
|---|---|---|
| `.png .jpg .jpeg .gif .webp` | the file must really be that image format | thumbnails, gallery |
| `.mp4 .webm` | the file must really be MP4 (`ftyp`) / WebM (EBML header) | an inline video, muted, with controls |
| `.md` | UTF-8 text, no NUL bytes | rendered Markdown preview |
| `.csv` | UTF-8 text | a table |
| `.txt` | UTF-8 text | plain text |
| `.html` | UTF-8 text | a live, sandboxed demo under the note; *expand* opens it at phone, tablet or desktop width |

An `.html` demo must be one self-contained file (inline `<style>` and `<script>`, images as `data:` URIs): it runs with
**no network access**, no cookies or storage, no forms or popups. See [security](security.md#html-demos).

Up to **1 MB per file**, **2 MB per video**, 30 files and 20 MB per PR (defaults: `MAX_FILE_MB`, `MAX_VIDEO_MB`,
`MAX_FILES`, `MAX_PULL_MB`; the skill served by your server states its own values). SVG, PDF, archives and other video
formats (`.mov`) are refused with `415`. Details in [security](security.md).

A **screen recording** is for what a screenshot can't show: an animation, a drag, a multi-step flow. Keep it a few
seconds and cropped; the skill records with Playwright's `recordVideo` and shrinks the clip with `ffmpeg` when needed.

## MCP instead of the skill

Any MCP client can annotate PRs through the server's `/mcp` endpoint, with the same token and no skill file: the tools
`upload_notes`, `get_notes` and `delete_notes` carry the skill's key rules in their descriptions. The skill still writes
better notes (it checks every note against the diff before uploading), so prefer it where your agent supports skills.

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

Details in [API](api.md#mcp).

## No secrets in notes

The skill (and the MCP tool descriptions) tell the agent never to upload API keys, passwords, tokens, private keys,
connection strings, `.env` values, session cookies or personal and customer data, in words or in screenshots and
recordings: it names the thing ("the Stripe key") instead of the value and crops or blurs it out of images. Still,
treat notes like any shared document: everyone in the account can read them until they expire.
