param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$PidPath = Join-Path $RepoPath '.git\autosave-watcher.pid'
$processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like "*autogit-watch.ps1*" -and
    $_.CommandLine -like "*$RepoPath*"
  }

foreach ($proc in $processes) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "Stopped autosave watcher PID: $($proc.ProcessId)"
}

Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
