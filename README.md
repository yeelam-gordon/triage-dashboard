# Triage Dashboard

A static GitHub Pages dashboard for daily/weekly triage of your repos, powered
by Copilot CLI running locally and consumed by an interactive browser UI.

## What it does

- **Local collector** (`scripts/triage-collect.ps1`) runs nightly via Task
  Scheduler. It invokes `copilot -p ...` to analyze tracked repos via `gh` and
  writes `data/latest.json` + `data/<date>.json`, then commits & pushes.
- **GitHub Pages** auto-deploys on push (`.github/workflows/deploy-pages.yml`).
- **Dashboard** (`index.html`, Alpine.js + Chart.js + compiled Tailwind,
  self-hosted under `assets/`) renders:
  - summary cards (open issues/PRs, no-reply backlog, category count)
  - category bar chart (Chart.js)
  - trending topics with 7d delta
  - no-reply queue with per-issue action buttons

## Public and local modes

The same dashboard runs in two modes:

### Public mode

`https://yeelam-gordon.github.io/triage-dashboard/`

- Shared, read-only view for everyone.
- No login, PAT, GitHub App, or browser token.
- Action receipts pushed by local operators are visible publicly.

### Local operator mode

```powershell
pwsh scripts\start-local-dashboard.ps1
```

Opens `http://127.0.0.1:43129/` and uses the account from `gh auth status`.
The local bridge binds only to loopback, serves the same UI/data, and exposes
fixed validated actions (no arbitrary shell endpoint):

| Action | Local command |
|---|---|
| Post reply | `gh issue/pr comment` |
| Apply labels | `gh issue/pr edit --add-label` |
| Assign owner | `gh issue/pr edit --add-assignee` |
| Close duplicate | comment, then `gh issue close` |
| Approve/request changes | `gh pr review` |
| Run review workflow | `gh workflow run` |

Copilot/code tasks remain reviewed, copyable local commands. The bridge records
successful actions in `data/actions/latest.json`; when `push_receipts` is true,
it commits and pushes the receipt so the public Pages view shows who applied it.

## First-time setup

1. **Create the repo** (or fork this one) — e.g. `yeelam-gordon/triage-dashboard`.
2. Push the contents of this folder.
3. In the repo on github.com: **Settings → Pages → Source: GitHub Actions**.
4. Open the deployed URL for the public read-only view.
5. Operators clone the repository, run `gh auth login`, then start local mode
   with `pwsh scripts\start-local-dashboard.ps1`.

`start-local-dashboard.ps1` pulls `origin/main` before starting. While running,
the local page pulls and reloads fresh dashboard data every five minutes.

Copy `local-config.example.json` to `local-config.json` to change the port,
or enable/disable receipt pushes.

## Local schedule

Register a Task Scheduler entry to run nightly:

```powershell
$action  = New-ScheduledTaskAction -Execute 'pwsh.exe' `
            -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\s\triage-dashboard\scripts\triage-collect.ps1' `
            -WorkingDirectory 'C:\s\triage-dashboard'
$trigger = New-ScheduledTaskTrigger -Daily -At 7am
Register-ScheduledTask -TaskName 'TriageDashboard-Collect' -Action $action -Trigger $trigger
```

## Per-repo views

The top of the dashboard has tabs: **All repos** + one tab per tracked repo,
showing each repo's issue count and a ⏰ badge for its no-reply backlog.
Clicking a tab filters every section (cards, chart, trends, queue) to that
repo and persists the choice in the URL hash:

```
https://<owner>.github.io/triage-dashboard/                              # All repos
https://<owner>.github.io/triage-dashboard/#repo=microsoft/intelligent-terminal   # one repo
```

Hash URLs are bookmarkable and shareable — handy for "the leadership view of
repo X" or for pinning a per-repo tab in your browser.

The JSON has an optional `per_repo` block so each tab shows *authoritative*
totals/trends rather than ones derived from the (capped) issue list. If
`per_repo[<name>]` is missing, the dashboard falls back to deriving counts
from the visible issues.

## Customize

- **Tracked repos** — edit the `-Repos` default in `scripts/triage-collect.ps1`.
- **Skills list** — `data/latest.json` → `skills`.
- **Review workflow filename** — `data/latest.json` → `config.review_workflow`.
- **Categories** — edit the categorization hint in the collector prompt.

## For agents pushing data from other machines

See [**AGENTS.md**](AGENTS.md) — the definitive contract for any agent
(Copilot CLI, GitHub Actions, custom scripts) writing data to this dashboard.
It covers the JSON schema, three delivery methods (git push / Contents API /
Actions cron), atomic-write rules, concurrency, and conventions.

## Why public + local?

- Zero hosting cost (GitHub Pages is free).
- Public users never receive write credentials.
- Local actions use each operator's existing `gh` identity and permissions.
- No GitHub App approval, PAT distribution, shared token, or central backend.
- The public dashboard and local operator view use the same repository/data.
