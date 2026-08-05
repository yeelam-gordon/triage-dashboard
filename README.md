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

## Authentication and actions

The public dashboard is read-only by default. It uses the GitHub Apps
**Single-page application support preview** (authorization-code flow with
mandatory PKCE) for secretless, backend-free GitHub login:

1. The browser redirects to GitHub to authorize the GitHub App.
2. GitHub redirects back with an authorization code.
3. The SPA exchanges the code directly with GitHub using PKCE (no client
   secret). GitHub enables CORS for callback URLs marked as SPA clients.
4. Access and refresh tokens remain in memory only and disappear on reload.
5. The dashboard checks active membership in the teams listed in
   `auth-config.json`. Authorized repos receive write actions; every other row
   remains read-only.

GitHub still enforces the actual security boundary: the user must have the
repository permission, and the GitHub App must be installed on that repository.
The browser team check controls dashboard UX but is not tamper-proof.

Actions that GitHub can perform directly use the user access token and are
attributed to the signed-in human. Coding/investigation work remains a local
Copilot CLI command in the Action queue:

| Button | API call |
|---|---|
| 💬 Preview reply | `POST /repos/{o}/{r}/issues/{n}/comments` as the signed-in user |
| 🏷 Apply labels | `POST /repos/{o}/{r}/issues/{n}/labels` as the signed-in user |
| 👤 Assign owner | `POST /repos/{o}/{r}/issues/{n}/assignees` as the signed-in user |
| 🗂 Close duplicate | Post the edited duplicate note, then close the issue as not planned |
| ✅ Approve / request changes | `POST /repos/{o}/{r}/pulls/{n}/reviews` as the signed-in user |
| 🛠 Run review skill | `POST /repos/{o}/{r}/actions/workflows/agent-review.yml/dispatches` with `inputs.skill` |
| ＋ Queue agent task | Stores a skill-aware `copilot -p "…"` command locally for copy/export |

## First-time setup

1. **Create the repo** (or fork this one) — e.g. `yeelam-gordon/triage-dashboard`.
2. Push the contents of this folder.
3. In the repo on github.com: **Settings → Pages → Source: GitHub Actions**.
4. Register a GitHub App (see [GitHub App setup](#github-app-setup)), install it
   on the target repositories, and put its public client ID in
   `auth-config.json`.
5. Open the deployed URL and click **Sign in**.
6. Drop `agent-review.yml` into each *target* repo too (so dispatch from the
   dashboard finds it). Or change `config.review_workflow` in `data/latest.json`
   to point at a workflow that already exists in each target repo.

## GitHub App setup

Register the GitHub App with:

- **Callback URL:** `https://yeelam-gordon.github.io/triage-dashboard/`
- **SPA client:** enabled (GitHub Apps SPA support preview)
- **Repository permissions:** Metadata read, Issues read/write, Pull requests
  read/write, Actions read/write
- **Organization permissions:** Members read
- **User access token expiration:** enabled

Install the app on only the target repositories. Copy the public **Client ID**
into `auth-config.json`. Add or change authorized teams there; each team maps
to the repository rows it can act on.

No client secret is stored in this repository or browser. If the GitHub App is
not configured, the dashboard fails closed to read-only.

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

## Why static + REST-from-browser?

- Zero hosting cost (GitHub Pages is free).
- No backend to maintain.
- No client secret in the page.
- GitHub App user tokens remain memory-only and actions are attributed to the
  signed-in user.
