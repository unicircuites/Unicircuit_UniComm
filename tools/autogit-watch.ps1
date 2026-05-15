param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [int]$IntervalSeconds = 2
)

$ErrorActionPreference = 'Continue'
$BranchName = 'autosave'
$LogPath = Join-Path $RepoPath '.git\autosave-watcher.log'
$LockPath = Join-Path $RepoPath '.git\autosave-watcher.lock'

function Write-AutosaveLog {
  param([string]$Message)
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $LogPath -Value "[$stamp] $Message"
}

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  Push-Location $RepoPath
  try {
    $output = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    return @{ Code = $code; Output = ($output -join "`n") }
  } finally {
    Pop-Location
  }
}

function Ensure-AutosaveBranch {
  $current = (Invoke-Git 'branch' '--show-current').Output.Trim()
  if ($current -eq $BranchName) { return $true }

  $exists = Invoke-Git 'branch' '--list' $BranchName
  if ([string]::IsNullOrWhiteSpace($exists.Output)) {
    $created = Invoke-Git 'checkout' '-b' $BranchName
    if ($created.Code -ne 0) {
      Write-AutosaveLog "Failed to create $BranchName branch: $($created.Output)"
      return $false
    }
    Write-AutosaveLog "Created and switched to $BranchName branch."
    return $true
  }

  $switched = Invoke-Git 'checkout' $BranchName
  if ($switched.Code -ne 0) {
    Write-AutosaveLog "Failed to switch to $BranchName branch: $($switched.Output)"
    return $false
  }
  Write-AutosaveLog "Switched to $BranchName branch."
  return $true
}

function Save-GitSnapshot {
  if (Test-Path -LiteralPath $LockPath) { return }
  New-Item -ItemType File -Path $LockPath -Force | Out-Null
  try {
    if (-not (Ensure-AutosaveBranch)) { return }

    $status = Invoke-Git 'status' '--porcelain'
    if ([string]::IsNullOrWhiteSpace($status.Output)) { return }

    $add = Invoke-Git 'add' '.'
    if ($add.Code -ne 0) {
      Write-AutosaveLog "git add failed: $($add.Output)"
      return
    }

    $diff = Invoke-Git 'diff' '--cached' '--quiet'
    if ($diff.Code -eq 0) { return }

    $message = 'Auto-change: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
    $commit = Invoke-Git 'commit' '-m' $message
    if ($commit.Code -eq 0) {
      Write-AutosaveLog "Committed: $message"
    } else {
      Write-AutosaveLog "git commit failed: $($commit.Output)"
    }
  } catch {
    Write-AutosaveLog "Autosave exception: $($_.Exception.Message)"
    try {
      Invoke-Git 'add' '.' | Out-Null
      $message = 'Auto-change: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
      Invoke-Git 'commit' '-m' $message | Out-Null
      Write-AutosaveLog "Failsafe commit attempted: $message"
    } catch {
      Write-AutosaveLog "Failsafe commit failed: $($_.Exception.Message)"
    }
  } finally {
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  }
}

Write-AutosaveLog "Autosave watcher started for $RepoPath"
Save-GitSnapshot

while ($true) {
  Start-Sleep -Seconds $IntervalSeconds
  Save-GitSnapshot
}
