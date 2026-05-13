# Uninstall Daily Git Push Reminder
# Run this script to remove the scheduled task

# Requires Administrator privileges
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "❌ This script requires Administrator privileges!" -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as Administrator', then run this script again." -ForegroundColor Yellow
    pause
    exit 1
}

Write-Host "Uninstalling Daily Git Push Reminder..." -ForegroundColor Cyan

try {
    # Remove main task
    Unregister-ScheduledTask -TaskName "GitPushDaily18" -Confirm:$false -ErrorAction SilentlyContinue
    
    # Remove reminder task (if exists)
    Unregister-ScheduledTask -TaskName "GitPushReminder" -Confirm:$false -ErrorAction SilentlyContinue
    
    Write-Host "✅ Successfully uninstalled!" -ForegroundColor Green
    Write-Host ""
    Write-Host "The daily 18:00:00 popup will no longer appear." -ForegroundColor White
    Write-Host ""
    
} catch {
    Write-Host "❌ Uninstallation failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

pause
