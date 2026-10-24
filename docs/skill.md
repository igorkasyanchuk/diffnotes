# Agent skill

← [README](../README.md)

The skill teaches a coding agent to explain a pull request to its reviewers and upload that explanation to Reviews42.
It works with **Claude Code**, **Codex**, **Cursor** and other tools that read Agent Skills. The full text the agent
reads is [`skill/reviews42/SKILL.md`](../skill/reviews42/SKILL.md), also served by your server at `/skill/SKILL.md`.

## Install

```bash
curl -fsSL https://reviews.company.com/install.sh | sh
```

It writes the skill to `~/.claude/skills/reviews42`, `~/.agents/skills/reviews42` and, when Cursor is installed,
`~/.cursor/skills/reviews42`. Then make a token on **Settings** (the app shows a bar until you have one) and add it to
your shell profile:

```bash
export REVIEWS42_URL=https://reviews.company.com
export REVIEWS42_TOKEN=r42_…
```

Run the install again to update the skill.

## Use

Open the PR's branch in your agent and ask: **“annotate this PR with reviews42”**. The agent:

1. finds the PR (`gh pr view`) and reads the change **from git**, not from memory;
2. writes one short note per changed block, a card per new/renamed/deleted file, and a summary; tests and generated files are skipped;
3. adds screenshots when the change is visible (for responsive UI: the same screen at mobile and desktop width, in one note → a gallery);
4. uploads everything in one request and reports the link.

Re-running after a push replaces the previous notes and files, so it is safe to repeat.

## What a note looks like

````json
{
  "title": "Express shipping at checkout",
  "head_sha": "4f2c…",
  "summary": "Adds an express option. Empty carts stop early. See the [test report](attachment:report.md).",
  "annotations": [
    { "path": "app/checkout.ts", "line": 43, "end_line": 45, "title": "Charge the express fee",
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
curl -fsS -X PUT "$REVIEWS42_URL/api/v1/pulls/acme/shop/42" -H "authorization: Bearer $REVIEWS42_TOKEN" \
  -F payload=@reviews42.json -F file=@mobile.png -F file=@desktop.png -F file=@report.md
```

## Files

| Allowed | Checked | Shown as |
|---|---|---|
| `.png .jpg .jpeg .gif .webp` | the file must really be that image format | thumbnails, gallery |
| `.md` | UTF-8 text, no NUL bytes | rendered Markdown preview |
| `.csv` | UTF-8 text | a table |
| `.txt` | UTF-8 text | plain text |
| `.html` | UTF-8 text | a live, sandboxed demo under the note; *expand* opens it at phone, tablet or desktop width |

An `.html` demo must be one self-contained file (inline `<style>` and `<script>`, images as `data:` URIs): it runs with
**no network access**, no cookies or storage, no forms or popups. See [security](security.md#html-demos).

Up to **1 MB per file**, 30 files and 20 MB per PR (server settings). SVG, PDF, archives and video are refused
with `415`. Details in [security](security.md).
