# Install Daily Git Push Reminder at 18:00:00
# Run this script ONCE to set up the scheduled task

# Requires Administrator privileges
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "❌ This script requires Administrator privileges!" -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as Administrator', then run this script again." -ForegroundColor Yellow
    pause
    exit 1
}

$scriptPath = "$PSScriptRoot\schedule-git-push.ps1"

if (-not (Test-Path $scriptPath)) {
    Write-Host "❌ Error: schedule-git-push.ps1 not found!" -ForegroundColor Red
    exit 1
}

Write-Host "Installing Daily Git Push Reminder..." -ForegroundColor Cyan
Write-Host "Task will run every day at 18:00:00" -ForegroundColor Cyan
Write-Host ""

# Create scheduled task
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -Daily -At "18:00:00"

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Highest

# Register task
try {
    Register-ScheduledTask `
        -TaskName "GitPushDaily18" `
        -Description "Daily Git push reminder at 18:00:00 for UniComm project" `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force | Out-Null
    
    Write-Host "✅ Successfully installed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "📋 Task Details:" -ForegroundColor Cyan
    Write-Host "  Name: GitPushDaily18" -ForegroundColor White
    Write-Host "  Time: 18:00:00 (every day)" -ForegroundColor White
    Write-Host "  Script: $scriptPath" -ForegroundColor White
    Write-Host ""
    Write-Host "🎯 What happens:" -ForegroundColor Cyan
    Write-Host "  - Every day at 18:00:00, a popup will appear" -ForegroundColor White
    Write-Host "  - Shows unpushed commits" -ForegroundColor White
    Write-Host "  - 3 buttons: Yes / Not Now / Remind in 10 min" -ForegroundColor White
    Write-Host ""
    Write-Host "🔧 To manage the task:" -ForegroundColor Cyan
    Write-Host "  - Open: Task Scheduler (taskschd.msc)" -ForegroundColor White
    Write-Host "  - Find: GitPushDaily18" -ForegroundColor White
    Write-Host ""
    Write-Host "🧪 To test now (without waiting until 18:00):" -ForegroundColor Cyan
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$scriptPath`"" -ForegroundColor Yellow
    Write-Host ""
    
} catch {
    Write-Host "❌ Installation failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

pause
