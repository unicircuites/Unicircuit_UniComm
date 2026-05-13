# Simple installation script without emoji characters

$scriptPath = "C:\Users\unius\Documents\code workout\UNI_CRM\schedule-git-push.ps1"

Write-Host "Installing GitPushDaily18 task..."

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -Daily -At "18:00:00"

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName "GitPushDaily18" -Description "Daily Git push reminder at 18:00:00" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force

Write-Host "Done. Check Task Scheduler for GitPushDaily18"
