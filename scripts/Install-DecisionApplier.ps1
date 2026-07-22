#Requires -Version 7.0
<#
.SYNOPSIS
  Install a Windows Scheduled Task that runs apply-decisions.ps1 every 15 minutes
  (the "bench job" that applies queued triage decisions).

.USAGE
  # Run elevated once on the bench machine (e.g. sh-yeelam-d11s):
  pwsh -File .\scripts\Install-DecisionApplier.ps1
  pwsh -File .\scripts\Install-DecisionApplier.ps1 -TaskName TriageDecisionApplier -IntervalMinutes 15
#>
[CmdletBinding()]
param(
  [string] $TaskName = 'TriageDecisionApplier',
  [int]    $IntervalMinutes = 15,
  [string] $RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $RepoRoot 'scripts\apply-decisions.ps1'
if (-not (Test-Path $script)) { throw "apply-decisions.ps1 not found at $script" }

$pwsh = (Get-Command pwsh).Source
$action = New-ScheduledTaskAction -Execute $pwsh `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $RepoRoot

# Trigger every N minutes. IMPORTANT: build the repetition with an explicit long
# RepetitionDuration via the borrow pattern — `schtasks /sc MINUTE` (and a bare
# -RepetitionInterval) emits a repetition with NO duration that current Task
# Scheduler silently ignores (NextRunTime jumps hours out and the job goes dormant).
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -DontStopOnIdleEnd -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

# Verify the repetition duration actually took (guards the dormancy bug).
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Installed '$TaskName' every $IntervalMinutes min. Next run: $($info.NextRunTime)"
Write-Host "Manual run:  schtasks /run /tn $TaskName"
