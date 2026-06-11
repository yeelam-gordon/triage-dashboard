# Triage Dashboard

A static GitHub Pages dashboard for daily/weekly triage of your repos, powered
by Copilot CLI running locally and consumed by an interactive browser UI.

## What it does

- **Local collector** (`scripts/triage-collect.ps1`) runs nightly via Task
  Scheduler. It invokes `copilot -p ...` to analyze tracked repos via `gh` and
  writes `data/latest.json` + `data/<date>.json`, then commits & pushes.
- **GitHub Pages** auto-deploys on push (`.github/workflows/deploy-pages.yml`).
- **Dashboard** (`index.html`, plain HTML + Alpine.js + Tailwind via CDN — no
  build step) renders:
  - summary cards (open issues/PRs, no-reply backlog, category count)
  - category bar chart (Chart.js)
  - trending topics with 7d delta
  - no-reply queue with per-issue action buttons

## Single-click actions

Each issue card exposes four actions that call the GitHub REST API directly
from the browser using a PAT you paste once (stored in `localStorage`):

| Button | API call |
|---|---|
| 💬 Preview reply | `POST /repos/{o}/{r}/issues/{n}/comments` (after you review/edit the suggested body) |
| 🤖 Send to Copilot | `POST /repos/{o}/{r}/issues/{n}/assignees` with `assignees:["Copilot"]` — triggers the Copilot coding agent |
| 🛠 Run review skill | `POST /repos/{o}/{r}/actions/workflows/agent-review.yml/dispatches` with `inputs.skill` |
| + label chip | `POST /repos/{o}/{r}/issues/{n}/labels` |

## First-time setup

1. **Create the repo** (or fork this one) — e.g. `yeelam-gordon/triage-dashboard`.
2. Push the contents of this folder.
3. In the repo on github.com: **Settings → Pages → Source: GitHub Actions**.
4. Open the deployed URL.
5. Click **🔒 Sign in**, paste a fine-grained PAT with:
   - `Issues: read & write`
   - `Pull requests: read & write`
   - `Actions: read & write`
   on the repos you triage.
6. Drop `agent-review.yml` into each *target* repo too (so dispatch from the
   dashboard finds it). Or change `config.review_workflow` in `data/latest.json`
   to point at a workflow that already exists in each target repo.

## Local schedule

Register a Task Scheduler entry to run nightly:

```powershell
$action  = New-ScheduledTaskAction -Execute 'pwsh.exe' `
            -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\s\triage-dashboard\scripts\triage-collect.ps1' `
            -WorkingDirectory 'C:\s\triage-dashboard'
$trigger = New-ScheduledTaskTrigger -Daily -At 7am
Register-ScheduledTask -TaskName 'TriageDashboard-Collect' -Action $action -Trigger $trigger
```

## Customize

- **Tracked repos** — edit the `-Repos` default in `scripts/triage-collect.ps1`.
- **Skills list** — `data/latest.json` → `skills`.
- **Review workflow filename** — `data/latest.json` → `config.review_workflow`.
- **Categories** — edit the categorization hint in the collector prompt.

## Why static + REST-from-browser?

- Zero hosting cost (GitHub Pages is free).
- No backend to maintain.
- Token never leaves your browser.
- For *personal* use only — if you ever share the URL, swap PAT for the
  GitHub OAuth Device Flow.
