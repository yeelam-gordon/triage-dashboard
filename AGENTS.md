# AGENTS.md — How to push data to this dashboard

This file is the contract between any agent (Copilot CLI, GitHub Actions
runner, custom script) running on **any machine** and the static dashboard
hosted at `https://<owner>.github.io/triage-dashboard/`.

If you are an agent: **read this file first.** Everything you need to know
about *what* to write and *how* to deliver it is here.

---

## TL;DR

1. Produce a JSON file matching the [Schema](#schema) section.
2. Write it to `data/latest.json` (and optionally `data/<YYYY-MM-DD>.json` for
   history).
3. Get it into this repo's `main` branch by one of the [Delivery methods](#delivery-methods).
4. Pages auto-deploys (~45s). Browser refresh shows the new data.

**Do not touch `index.html`, `*.html`, `*.css`, `scripts/`, or anything under
`.github/`** unless the user explicitly asks. Data agents write only under
`data/`.

---

## Schema

`data/latest.json` is the single file the dashboard reads. Schema (all
top-level keys are optional unless marked **required**; unknown keys are
ignored):

```jsonc
{
  // REQUIRED — ISO 8601 UTC, used in the header "Updated …" line
  "generated_at": "2026-06-12T07:00:00Z",

  // Optional — overrides defaults in index.html
  "config": {
    "review_workflow": "agent-review.yml",   // filename in target repos for the "Run review skill" button
    "default_ref": "main"                     // git ref to dispatch workflows against
  },

  // Optional — populates the skill picker dropdown
  "skills": ["copilot-pr-prereview", "copilot-pr-autopilot", "upstream-sync"],

  // Optional — top-of-dashboard summary cards (when "All repos" tab is active)
  "totals": { "open_issues": 142, "open_prs": 18 },

  // Optional — drives the category bar chart on "All repos"
  "category_counts": { "autofix": 24, "agent-pane": 31, "other": 41 },

  // Optional — drives the trending topics list on "All repos"
  "trends": [
    { "topic": "autofix triggers on stashed pane", "count": 7, "delta": 4 }
    // delta = count this 7d window minus prior 7d window
  ],

  // RECOMMENDED — authoritative per-repo numbers so per-repo tabs don't
  // undercount (the "issues" array below is capped, so deriving totals
  // from it would be wrong). Map "<owner>/<repo>" -> per-repo block.
  "per_repo": {
    "microsoft/intelligent-terminal": {
      "totals": { "open_issues": 128, "open_prs": 15 },
      "category_counts": { "autofix": 24, "agent-pane": 31 },
      "trends": [ { "topic": "...", "count": 5, "delta": 2 } ]
    }
  },

  // REQUIRED — the no-reply queue. Cap at ~60 per repo, prioritize oldest
  // no-reply first. Each entry MUST have at least: repo, number, title, url.
  "issues": [
    {
      "repo": "microsoft/intelligent-terminal",   // REQUIRED, "<owner>/<repo>"
      "number": 1234,                              // REQUIRED, integer
      "title": "Autofix pill not appearing …",    // REQUIRED
      "url": "https://github.com/microsoft/intelligent-terminal/issues/1234",  // REQUIRED

      "category": "autofix",                       // free-form string; powers chart + filter
      "days_no_reply": 12,                         // integer; ≥7 shows ⏰ badge

      // Drives the chip row under each issue. Apply via single click → POST /labels.
      "suggested_labels": ["area-autofix", "needs-repro"],

      // Drives the 💬 Preview reply modal. Markdown supported (rendered as plain text in textarea).
      // Keep ≤ ~800 chars so the modal stays usable. End with actionable next step.
      "suggested_reply": "Thanks for the report! Could you share …"
    }
  ]
}
```

### Schema rules

- **Always overwrite `data/latest.json` in full.** Do not patch fields.
- **Atomic write only.** Write to `data/latest.json.tmp` then rename. Half-written
  JSON breaks the dashboard for everyone until the next push.
- **Repo IDs are `<owner>/<repo>`** — match the GitHub URL casing exactly. The
  per-repo tab key must equal the `issues[].repo` value, or the tab won't filter.
- **`days_no_reply` semantics:** days since last comment by *any non-author*
  account. If the original author replied last, set to `0` regardless of age.
- **`suggested_reply` must be safe to post verbatim.** A human reviews in the
  modal but the default action is "send as-is."
- **No secrets.** This repo is public. PATs, internal hostnames, customer
  data → never. If in doubt, omit.
- **Keep `issues[]` ≤ ~300 total** (or ~60 per repo). The dashboard renders all
  of them; larger sets degrade scroll performance. Prioritize:
  1. `days_no_reply` descending
  2. issues @-mentioning the dashboard owner
  3. issues with no labels yet

### Optional `data/<YYYY-MM-DD>.json` (history)

If you also write a date-stamped copy, future versions of the dashboard will
render day-over-day diffs. Use UTC date, no timezone suffix:
`data/2026-06-12.json`. Never overwrite an existing date file.

### Full backlog: `data/owed/<owner>-<repo>.json`

Each repo's **complete** owed backlog (every open issue/PR, as lightweight rows)
lives in `data/owed/<slug>.json` and is lazy-loaded when a repo tab is opened.
`latest.json` carries only the top deeply-triaged slice plus a per-repo
`owed_list` summary (with an `owed_file` pointer). Keep `baseline_action` (and,
for PRs, `merge_state`/`review_decision`) on **every** owed row — the dashboard
derives each row's triage State and its "▶ Run agent" action from those, so the
whole backlog stays actionable, not just the triaged slice. Set the true open
totals: global `owed_list.issues_total`/`prs_total`, and per-repo
`owed_list.backlog_issues`/`backlog_prs` (drives the header "open backlog").

### Dashboard-derived fields (client-side — you do NOT emit these)

The dashboard computes these from the fields above; don't add them to the JSON:

- **Triage State** — one mutually-exclusive pill per row, from `next_action`
  (deep-triaged) or `baseline_action` (lightweight). See
  `scripts/collector-prompt.md` for the full vocabulary.
- **Ranking** — default "Priority" = actionable → problem → recency
  (`updated_at` desc). Keep `updated_at` accurate.
- **PowerToys module skills** — mapped client-side from `Product-*` labels to the
  `powertoys-<module>-knowledge` skills in `yeelam-gordon/PowerToys#86`; the
  Run-agent prompt references the matching skill. No `skill` field needed — just
  keep PowerToys `Product-*` labels accurate.

The authoritative field contract and deep-triage cap guidance live in
[`scripts/collector-prompt.md`](scripts/collector-prompt.md).

---

## Delivery methods

Pick the one that matches your runtime. All three end up the same way:
new commit on `main` → Pages workflow → live in ~45s.

### Method A — git push (recommended for machines with a checkout)

```powershell
# (one-time on the machine)
gh repo clone <owner>/triage-dashboard
cd triage-dashboard

# (each run)
# … your collector writes data/latest.json and data/<date>.json …
git add data/
if (git diff --cached --quiet) { exit 0 }     # no changes -> no commit
git -c user.name='triage-bot' -c user.email='triage-bot@<host>' `
    commit -m "triage: $(Get-Date -Format yyyy-MM-dd) (<host>)"
git pull --rebase --autostash                  # in case another machine pushed first
git push origin main
```

POSIX equivalent (bash):

```bash
git add data/
git diff --cached --quiet && exit 0
git -c user.name=triage-bot -c user.email=triage-bot@$(hostname) \
    commit -m "triage: $(date -u +%F) ($(hostname))"
git pull --rebase --autostash
git push origin main
```

**Concurrency.** If multiple machines push, always `git pull --rebase --autostash`
before push. The collector should be idempotent so a rebase replays cleanly.

### Method B — GitHub Contents API (no checkout, no git)

Use when the machine has only `curl` + a PAT and you don't want a clone.

```bash
OWNER=<owner>
REPO=triage-dashboard
BRANCH=main
PATH_IN_REPO=data/latest.json
MSG="triage: $(date -u +%F)"

# Get current sha (needed for update; omit for first create)
SHA=$(curl -sS -H "Authorization: Bearer $GH_TOKEN" \
       "https://api.github.com/repos/$OWNER/$REPO/contents/$PATH_IN_REPO?ref=$BRANCH" \
       | jq -r '.sha // empty')

CONTENT=$(base64 -w0 < data/latest.json)
BODY=$(jq -n --arg m "$MSG" --arg c "$CONTENT" --arg b "$BRANCH" --arg s "$SHA" \
       '{message:$m, content:$c, branch:$b} + (if $s == "" then {} else {sha:$s} end)')

curl -sS -X PUT -H "Authorization: Bearer $GH_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/$OWNER/$REPO/contents/$PATH_IN_REPO" \
     -d "$BODY"
```

PAT scope needed: **`Contents: read & write`** on this repo (fine-grained PAT).

### Method C — GitHub Actions cron (no agent machine at all)

If your second machine is unreliable or you'd rather run the collector in the
cloud, create `.github/workflows/collect.yml` in this repo:

```yaml
name: Collect (cron)
on:
  schedule: [{ cron: '0 14 * * *' }]   # 14:00 UTC ≈ 7am PT
  workflow_dispatch:
permissions:
  contents: write
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm i -g @github/copilot
      - env:
          GH_TOKEN: ${{ secrets.TARGET_REPOS_PAT }}   # PAT with Issues:read on the analyzed repos
        run: |
          copilot -p "$(cat scripts/collector-prompt.md)" \
            --allow-tool 'shell(gh)' --allow-tool 'write'
      - run: |
          git config user.name triage-bot
          git config user.email bot@github-actions
          git add data/
          git diff --cached --quiet || (git commit -m "triage: $(date -u +%F)" && git push)
```

---

## Conventions for collector authors

- **Single source of truth for the prompt.** If you have a long Copilot prompt,
  put it in `scripts/collector-prompt.md` and reference it from your runner.
  Don't fork the prompt across machines.
- **Idempotent runs.** Running the collector twice in a row should produce
  byte-identical (or near-identical) `latest.json`. Don't embed run-IDs,
  random ordering, or wall-clock-precise timestamps inside `issues[]`.
- **Stable ordering.** Sort `issues[]` by `(repo, number)` before writing.
  Stable order = clean git diffs = easy review.
- **JSON formatting.** Pretty-print with 2-space indent. Trailing newline.
  Use `ConvertTo-Json -Depth 20` (PowerShell) or `jq .` (POSIX).
- **Don't leak local paths.** No `C:\Users\...` or `/home/...` strings inside
  `suggested_reply` or anywhere else in the JSON.
- **Validate before push.** Parse the file with `ConvertFrom-Json` or `jq empty`
  and abort the push on parse failure. A broken JSON file silently blanks the
  dashboard.

---

## File layout reference

```
triage-dashboard/
├── index.html                       # dashboard UI — DO NOT EDIT from data agents
├── data/
│   ├── latest.json                  # ← write target (always)
│   └── 2026-06-12.json              # ← optional history (never overwrite)
├── scripts/
│   ├── triage-collect.ps1           # reference collector — copy/adapt per machine
│   └── collector-prompt.md          # (optional) shared prompt text
├── .github/workflows/
│   ├── deploy-pages.yml             # auto-deploy on push — DO NOT EDIT
│   └── agent-review.yml             # workflow_dispatch target — leave alone
├── README.md                        # human-facing setup guide
└── AGENTS.md                        # ← this file
```

---

## When in doubt

- **The schema in this file wins** over anything you remember from a previous
  conversation. If `index.html` reads a field that's not documented here,
  open a PR to document it before relying on it.
- **Ask the dashboard owner** (the repo owner on github.com) before adding new
  top-level keys, changing required field shapes, or introducing a second
  data file the dashboard would need to read.
- **Failing closed is better than failing weird.** If your collector hits an
  error, write nothing rather than write partial data.
