param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$ScriptPath = Join-Path $PSScriptRoot 'autogit-watch.ps1'
$PidPath = Join-Path $RepoPath '.git\autosave-watcher.pid'

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like "*autogit-watch.ps1*" -and
    $_.CommandLine -like "*$RepoPath*"
  }

if ($existing) {
  $existing.ProcessId | Select-Object -First 1 | Set-Content -LiteralPath $PidPath
  Write-Output "Autosave watcher already running. PID: $($existing[0].ProcessId)"
  exit 0
}

$argList = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', "`"$ScriptPath`"",
  '-RepoPath', "`"$RepoPath`"",
  '-IntervalSeconds', '2'
)

$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath $PidPath
Write-Output "Autosave watcher started. PID: $($process.Id)"
