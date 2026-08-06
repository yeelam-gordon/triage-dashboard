#Requires -Version 7.0
[CmdletBinding()]
param(
    [int] $Port,
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) is required.'
}
gh auth status 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) { throw 'Run gh auth login first.' }

Write-Host 'Syncing dashboard data from origin/main...' -ForegroundColor Cyan
$branch = git branch --show-current
if ($branch -ne 'main') { throw "Local operator mode must run from the main branch (current: $branch)." }
$staged = @(git diff --cached --name-only)
if ($staged.Count) { throw "Unstage existing files before starting local operator mode: $($staged -join ', ')" }
$changes = @(git status --porcelain --untracked-files=no)
if ($changes.Count) { throw "Commit or stash tracked changes before starting local operator mode: $($changes -join ', ')" }
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Unable to update the dashboard checkout from origin/main.' }

if (-not (Test-Path 'local-config.json') -and (Test-Path 'local-config.example.json')) {
    Copy-Item 'local-config.example.json' 'local-config.json'
    Write-Host 'Created local-config.json. Set push_receipts=false if local actions should not update Pages.' -ForegroundColor Yellow
}

$settings = Get-Content 'local-config.json' -Raw | ConvertFrom-Json
$effectivePort = if ($PSBoundParameters.ContainsKey('Port')) { $Port } else { [int]$settings.port }
if ($PSBoundParameters.ContainsKey('Port')) { $env:TRIAGE_PORT = [string]$Port } else { Remove-Item Env:TRIAGE_PORT -ErrorAction SilentlyContinue }
$url = "http://127.0.0.1:$effectivePort/"
if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($target)
        Start-Sleep -Seconds 1
        Start-Process $target
    } -ArgumentList $url | Out-Null
}

Write-Host "Starting local operator dashboard at $url" -ForegroundColor Green
node scripts/local-server.mjs
