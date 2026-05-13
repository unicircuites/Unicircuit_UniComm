# Scheduled Git Push - Runs at 18:00:00 daily
# Shows popup asking to push to GitHub

$repoPath = "C:\Users\unius\Documents\code workout\UNI_CRM"

# Change to repo directory
Set-Location $repoPath

# Check if there are commits to push
$status = git status --porcelain
$unpushedCommits = git log origin/master..HEAD --oneline 2>$null

if (-not $unpushedCommits) {
    # No commits to push
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "No commits to push to GitHub.`n`nEverything is up to date!",
        "Git Push - Nothing to Push",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    )
    exit 0
}

# Count commits
$commitCount = ($unpushedCommits | Measure-Object).Count

# Load Windows Forms
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Create form
$form = New-Object System.Windows.Forms.Form
$form.Text = "Git Push - 18:00:00 Reminder"
$form.Size = New-Object System.Drawing.Size(550, 300)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Icon = [System.Drawing.SystemIcons]::Information

# Title label
$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Location = New-Object System.Drawing.Point(20, 20)
$titleLabel.Size = New-Object System.Drawing.Size(500, 30)
$titleLabel.Text = "It's 18:00:00 - Time to push to GitHub!"
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.Color]::DarkGreen
$form.Controls.Add($titleLabel)

# Message label
$messageLabel = New-Object System.Windows.Forms.Label
$messageLabel.Location = New-Object System.Drawing.Point(20, 60)
$messageLabel.Size = New-Object System.Drawing.Size(500, 60)
$messageLabel.Text = "You have $commitCount unpushed commit(s) in:`n$repoPath`n`nDo you want to push to GitHub now?"
$messageLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$form.Controls.Add($messageLabel)

# Commits preview
$commitsLabel = New-Object System.Windows.Forms.Label
$commitsLabel.Location = New-Object System.Drawing.Point(20, 130)
$commitsLabel.Size = New-Object System.Drawing.Size(500, 80)
$commitsLabel.Text = "Recent commits:`n" + ($unpushedCommits | Select-Object -First 3 | Out-String)
$commitsLabel.Font = New-Object System.Drawing.Font("Consolas", 8)
$commitsLabel.ForeColor = [System.Drawing.Color]::DarkBlue
$form.Controls.Add($commitsLabel)

# Yes button
$yesButton = New-Object System.Windows.Forms.Button
$yesButton.Location = New-Object System.Drawing.Point(50, 220)
$yesButton.Size = New-Object System.Drawing.Size(150, 40)
$yesButton.Text = "Yes, Push Now"
$yesButton.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$yesButton.BackColor = [System.Drawing.Color]::LightGreen
$yesButton.DialogResult = [System.Windows.Forms.DialogResult]::Yes
$form.Controls.Add($yesButton)

# No button
$noButton = New-Object System.Windows.Forms.Button
$noButton.Location = New-Object System.Drawing.Point(210, 220)
$noButton.Size = New-Object System.Drawing.Size(150, 40)
$noButton.Text = "Not Now"
$noButton.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$noButton.BackColor = [System.Drawing.Color]::LightCoral
$noButton.DialogResult = [System.Windows.Forms.DialogResult]::No
$form.Controls.Add($noButton)

# Remind button
$remindButton = New-Object System.Windows.Forms.Button
$remindButton.Location = New-Object System.Drawing.Point(370, 220)
$remindButton.Size = New-Object System.Drawing.Size(150, 40)
$remindButton.Text = "Remind in 10 min"
$remindButton.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$remindButton.BackColor = [System.Drawing.Color]::LightYellow
$remindButton.DialogResult = [System.Windows.Forms.DialogResult]::Retry
$form.Controls.Add($remindButton)

# Show dialog
$result = $form.ShowDialog()
$form.Dispose()

switch ($result) {
    "Yes" {
        # Push to GitHub
        Write-Host "Pushing to GitHub..." -ForegroundColor Green
        git push origin master
        
        if ($LASTEXITCODE -eq 0) {
            [System.Windows.Forms.MessageBox]::Show(
                "Successfully pushed $commitCount commit(s) to GitHub!",
                "Git Push - Success",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            )
        } else {
            [System.Windows.Forms.MessageBox]::Show(
                "Push failed! Please check the console for errors.",
                "Git Push - Error",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error
            )
        }
    }
    "Retry" {
        # Schedule reminder in 10 minutes
        $reminderTime = (Get-Date).AddMinutes(10)
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
        $trigger = New-ScheduledTaskTrigger -Once -At $reminderTime
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        
        Register-ScheduledTask -TaskName "GitPushReminder" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        
        [System.Windows.Forms.MessageBox]::Show(
            "Reminder set for $($reminderTime.ToString('HH:mm:ss'))",
            "Git Push - Reminder Set",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
    }
    default {
        Write-Host "Push cancelled by user" -ForegroundColor Yellow
    }
}
