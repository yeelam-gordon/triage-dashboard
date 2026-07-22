#Requires -Version 7.0
<#
.SYNOPSIS
  Apply queued triage decisions (the "15-minute bench job").

  Reads approved decisions from data/decisions/pending/, RE-CHECKS applicability
  against the live issue/PR (still open? author didn't already get our reply?
  label not already present?), applies the ones that still apply via `gh`, and
  moves each record to data/decisions/applied/ or data/decisions/skipped/ with a
  reason. Also writes data/decisions/results.json (importable by the dashboard)
  and commits/pushes.

.INPUTS
  Two accepted layouts under data/decisions/pending/ :
   - one file per decision:  <repo-slug>#<number>.json  (contents = a decision object)
   - a single decisions-export.json:  { generated_at, decisions: { "repo#num": {..} } }

.USAGE
  pwsh .\scripts\apply-decisions.ps1                 # apply
  pwsh .\scripts\apply-decisions.ps1 -DryRun         # re-check only, apply nothing
  Schedule every 15 min with scripts\Install-DecisionApplier.ps1

.NOTES
  Requires `gh` authenticated with write scope on the target repos.
#>
[CmdletBinding()]
param(
  [string] $RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
Set-Location $RepoRoot

$decDir     = Join-Path $RepoRoot 'data/decisions'
$pendingDir = Join-Path $decDir 'pending'
$appliedDir = Join-Path $decDir 'applied'
$skippedDir = Join-Path $decDir 'skipped'
foreach ($d in @($decDir, $pendingDir, $appliedDir, $skippedDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# ---- Collect decisions (both layouts) ----
$decisions = @{}  # key "repo#number" -> decision object
foreach ($f in Get-ChildItem $pendingDir -Filter *.json -File -ErrorAction SilentlyContinue) {
  $obj = Get-Content $f.FullName -Raw | ConvertFrom-Json
  if ($obj.decisions) {
    foreach ($p in $obj.decisions.PSObject.Properties) { $decisions[$p.Name] = $p.Value }
  } elseif ($obj.repo -and $obj.number) {
    $decisions["$($obj.repo)#$($obj.number)"] = $obj
  }
}
if ($decisions.Count -eq 0) { Write-Host 'No pending decisions.'; return }
Write-Host "Found $($decisions.Count) pending decision(s)."

$results = @{}

function Save-Result([string]$key, [string]$status, [string]$reason, $decision) {
  $script:results[$key] = [ordered]@{ status = $status; reason = $reason; at = (Get-Date).ToUniversalTime().ToString('o') }
  $slug = ($key -replace '/', '-' -replace '#', '_')
  $dest = if ($status -eq 'applied') { $appliedDir } else { $skippedDir }
  $rec = [ordered]@{ key = $key; status = $status; reason = $reason; decision = $decision; at = $script:results[$key].at }
  $rec | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $dest "$slug.json") -Encoding utf8
}

foreach ($key in $decisions.Keys) {
  $d = $decisions[$key]
  $repo = $d.repo; $num = [int]$d.number
  try {
    # ---- Re-check applicability against the LIVE item ----
    $live = gh issue view $num --repo $repo --json state,closed,updatedAt,labels,comments 2>$null | ConvertFrom-Json
    if (-not $live) { $live = gh pr view $num --repo $repo --json state,closed,updatedAt,labels 2>$null | ConvertFrom-Json }
    if (-not $live) { Save-Result $key 'skipped' 'item not found (transferred/deleted)' $d; continue }
    if ($live.state -eq 'CLOSED' -or $live.closed -eq $true) { Save-Result $key 'skipped' 'already closed' $d; continue }

    # Reply/close: skip if the item got new activity after approval (author may have replied)
    if ($d.snapshot -and $d.snapshot.updated_at) {
      $approvedFor = [datetime]$d.snapshot.updated_at
      $liveUpdated = [datetime]$live.updatedAt
      if (($d.action -eq 'comment' -or $d.action -eq 'close_dup') -and $liveUpdated -gt $approvedFor.AddMinutes(1)) {
        Save-Result $key 'skipped' "new activity since approval ($($live.updatedAt)) — re-triage" $d; continue
      }
    }

    $liveLabels = @($live.labels | ForEach-Object { $_.name })

    if ($DryRun) { Save-Result $key 'skipped' 'dry-run (still-applicable)' $d; continue }

    switch ($d.action) {
      'comment' {
        gh issue comment $num --repo $repo --body $d.body | Out-Null
        Save-Result $key 'applied' 'comment posted' $d
      }
      'labels' {
        $toAdd = @($d.labels | Where-Object { $_ -and ($liveLabels -notcontains $_) })
        if ($toAdd.Count -eq 0) { Save-Result $key 'skipped' 'labels already present' $d; break }
        $args = @('issue','edit',$num,'--repo',$repo); foreach ($l in $toAdd) { $args += @('--add-label',$l) }
        gh @args | Out-Null
        Save-Result $key 'applied' "added: $($toAdd -join ', ')" $d
      }
      'close_dup' {
        if ($d.body) { gh issue comment $num --repo $repo --body $d.body | Out-Null }
        gh issue close $num --repo $repo --reason 'not planned' | Out-Null
        Save-Result $key 'applied' 'commented + closed as duplicate' $d
      }
      default { Save-Result $key 'skipped' "unknown action '$($d.action)'" $d }
    }
  } catch {
    Save-Result $key 'skipped' "error: $($_.Exception.Message)" $d
  }
}

# ---- Write results file (dashboard imports this) ----
@{ generated_at = (Get-Date).ToUniversalTime().ToString('o'); results = $results } |
  ConvertTo-Json -Depth 20 | Set-Content (Join-Path $decDir 'results.json') -Encoding utf8

# ---- Clear applied/skipped from pending ----
foreach ($key in $results.Keys) {
  $slug = ($key -replace '/', '-' -replace '#', '_')
  Remove-Item (Join-Path $pendingDir "$slug.json") -ErrorAction SilentlyContinue
}
# If a single export bundle was used, prune keys that were all processed
foreach ($f in Get-ChildItem $pendingDir -Filter *.json -File -ErrorAction SilentlyContinue) {
  $obj = Get-Content $f.FullName -Raw | ConvertFrom-Json
  if ($obj.decisions) {
    $remaining = $obj.decisions.PSObject.Properties | Where-Object { -not $results.ContainsKey($_.Name) }
    if (-not $remaining) { Remove-Item $f.FullName -ErrorAction SilentlyContinue }
  }
}

$applied = @($results.Values | Where-Object { $_.status -eq 'applied' }).Count
$skipped = @($results.Values | Where-Object { $_.status -eq 'skipped' }).Count
Write-Host "Applied $applied, skipped $skipped."

# ---- Commit + push (idempotent; safe with the collector's own pushes) ----
if (-not $DryRun) {
  git add data/decisions/ 2>$null
  if (-not (git diff --cached --quiet)) {
    git -c user.name='triage-applier' -c user.email='triage-applier@localhost' commit -m "decisions: applied $applied, skipped $skipped ($(Get-Date -Format yyyy-MM-ddTHH:mm))" | Out-Null
    git pull --rebase --autostash 2>$null
    git push origin main 2>$null
    Write-Host 'Pushed.'
  }
}
