#Requires -Version 7.0
<#
.SYNOPSIS
  Nightly triage collector. Runs Copilot CLI to analyze tracked repos and
  produces data/latest.json + data/YYYY-MM-DD.json, then commits & pushes.

.USAGE
  pwsh .\scripts\triage-collect.ps1
  pwsh .\scripts\triage-collect.ps1 -Repos 'microsoft/intelligent-terminal','yeelam-gordon/awesome-copilot'

.SCHEDULING (Windows Task Scheduler, run daily 07:00)
  Action:  pwsh.exe
  Args:    -NoProfile -ExecutionPolicy Bypass -File "C:\s\triage-dashboard\scripts\triage-collect.ps1"
  Start in: C:\s\triage-dashboard
#>
[CmdletBinding()]
param(
    [string[]] $Repos = @(
        'microsoft/intelligent-terminal',
        'yeelam-gordon/awesome-copilot'
    ),
    [string] $RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-Location $RepoRoot

$today    = Get-Date -Format 'yyyy-MM-dd'
$dataDir  = Join-Path $RepoRoot 'data'
$daily    = Join-Path $dataDir "$today.json"
$latest   = Join-Path $dataDir 'latest.json'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$reposList = ($Repos | ForEach-Object { "  - $_" }) -join "`n"

$prompt = @"
You are a triage analyst. For each repo below, use the 'gh' CLI to inspect open
issues and PRs, then write a single JSON file at '$($daily.Replace('\','/'))'.

Repos:
$reposList

For each open issue (cap at 60 per repo, prioritizing oldest no-reply first):
  - repo, number, title, url
  - category: one of [autofix, agent-pane, settings-ui, rendering, shell-integration, docs, other] (infer from labels + title + body)
  - days_no_reply: days since last non-author comment (0 if author last replied)
  - suggested_labels: 1-3 labels NOT already on the issue
  - suggested_reply: a draft maintainer reply that asks for the most useful next info OR explains likely root cause. Use repo conventions you know about.

Also compute:
  - totals.open_issues, totals.open_prs (sums across repos)
  - category_counts: map of category -> count
  - trends: top 5 topics from the last 7 days of new issues, each with { topic, count, delta vs prior 7d }
  - generated_at: ISO 8601 timestamp now

Use this exact JSON schema (see data/latest.json for reference shape).
Preserve the 'config' and 'skills' fields from the existing data/latest.json if present.

After writing the JSON, validate it parses as JSON, then exit.
"@

Write-Host "Running Copilot triage analyst..." -ForegroundColor Cyan
& copilot -p $prompt --allow-tool 'shell(gh)' --allow-tool 'write'

if (-not (Test-Path $daily)) {
    throw "Copilot did not produce $daily"
}

# Validate JSON
$null = Get-Content $daily -Raw | ConvertFrom-Json

# Update latest.json (preserve config/skills from prior latest if Copilot didn't carry them over)
if (Test-Path $latest) {
    $prior = Get-Content $latest -Raw | ConvertFrom-Json
    $new   = Get-Content $daily  -Raw | ConvertFrom-Json
    if (-not $new.config -and $prior.config) { $new | Add-Member -NotePropertyName config -NotePropertyValue $prior.config -Force }
    if (-not $new.skills -and $prior.skills) { $new | Add-Member -NotePropertyName skills -NotePropertyValue $prior.skills -Force }
    $new | ConvertTo-Json -Depth 20 | Set-Content $latest -Encoding utf8
} else {
    Copy-Item $daily $latest -Force
}

Write-Host "Committing..." -ForegroundColor Cyan
git add data/
if (git diff --cached --quiet) {
    Write-Host "No data changes; skipping commit." -ForegroundColor Yellow
    exit 0
}
git -c user.name='triage-bot' -c user.email='triage-bot@localhost' commit -m "triage: $today"
git push origin main
Write-Host "Done." -ForegroundColor Green
