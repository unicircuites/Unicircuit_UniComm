# UniComm Pro — Tower Server Setup & Startup Installer
# Run this script as Administrator on the Tower Server.
# Usage: powershell -ExecutionPolicy Bypass -File .\setup-tower.ps1

# ── STEP 1: Verify Administrator Privileges ──
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script MUST be run as an Administrator. Please run PowerShell as Administrator and try again."
    Exit
}

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) {
    $scriptRoot = Get-Location
}
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "       UniComm Pro Tower Server Setup & Auto-Start       " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "Working Directory: $scriptRoot" -ForegroundColor Gray

# ── STEP 2: Configure OneDrive Storage Path ──
Write-Host "`n[1/7] Configuring custom storage directories..." -ForegroundColor Yellow
$userProfile = [System.Environment]::GetFolderPath("UserProfile")
$defaultOneDrive = Join-Path $userProfile "OneDrive\UniComm_Storage"
Write-Host "This app stores high-volume media (photos, videos, voice recordings) in OneDrive to save C: drive space." -ForegroundColor Gray
$oneDriveInput = Read-Host "Enter target OneDrive path [Default: $defaultOneDrive]"
$oneDrivePath = if ([string]::IsNullOrWhiteSpace($oneDriveInput)) { $defaultOneDrive } else { $oneDriveInput }

# Ensure absolute path format
$oneDrivePath = [System.IO.Path]::GetFullPath($oneDrivePath)
Write-Host "Configured storage root: $oneDrivePath" -ForegroundColor Green

# Create the required subdirectories in OneDrive
$subdirs = @("wa_media", "wa_backups", "pbx_recordings", "outlook_backups", "call_backups")
foreach ($dir in $subdirs) {
    $targetPath = Join-Path $oneDrivePath $dir
    if (-not (Test-Path $targetPath)) {
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        Write-Host "Created folder: $targetPath" -ForegroundColor Gray
    } else {
        Write-Host "Folder already exists: $targetPath" -ForegroundColor Gray
    }
}

# ── STEP 3: Setup Project Dependencies ──
Write-Host "`n[2/7] Installing NPM packages..." -ForegroundColor Yellow
Set-Location $scriptRoot

# Root dependencies
if (Test-Path "package.json") {
    Write-Host "Installing root dependencies..." -ForegroundColor Gray
    npm install
}

# Backend dependencies
$backendDir = Join-Path $scriptRoot "backend"
if (Test-Path $backendDir) {
    Set-Location $backendDir
    Write-Host "Installing backend dependencies..." -ForegroundColor Gray
    npm install
} else {
    Write-Error "Backend directory not found at $backendDir!"
    Exit
}

# ── STEP 4: Configure environment variables (.env) ──
Write-Host "`n[3/7] Setting up environment variables (.env)..." -ForegroundColor Yellow
$envPath = Join-Path $backendDir ".env"
$envExamplePath = Join-Path $backendDir ".env.example"

# Base configuration hash table
$config = @{}

# Load existing .env values if available to preserve API keys, SMTP credentials, etc.
if (Test-Path $envPath) {
    Write-Host "Existing .env found. Loading active settings..." -ForegroundColor Gray
    Get-Content $envPath | ForEach-Object {
        if ($_ -match "^\s*([^#=\s]+)\s*=\s*(.*)\s*$") {
            $config[$Matches[1]] = $Matches[2].Trim()
        }
    }
} elseif (Test-Path $envExamplePath) {
    Write-Host "No active .env found. Using .env.example as baseline..." -ForegroundColor Gray
    Get-Content $envExamplePath | ForEach-Object {
        if ($_ -match "^\s*([^#=\s]+)\s*=\s*(.*)\s*$") {
            $config[$Matches[1]] = $Matches[2].Trim()
        }
    }
}

# Apply Tower-specific production overrides
$config["NODE_ENV"] = "production"
$config["PORT"] = "8088"
$config["HOST"] = "0.0.0.0"
$config["SSL_KEY_PATH"] = "certs/server.key"
$config["SSL_CERT_PATH"] = "certs/server.crt"
$config["APP_PUBLIC_URL"] = "https://192.168.0.205:8088"
$config["MS_REDIRECT_URI"] = "https://192.168.0.205:8088/auth/callback"
$config["SMDR_PORT"] = "5001"
$config["CTI_PORT"] = "4000"

# Apply the custom OneDrive paths (double backslashes for node/windows safety)
$safeOneDrivePath = $oneDrivePath.Replace("\", "\\")
$config["WA_MEDIA_DIR"] = "$safeOneDrivePath\\wa_media"
$config["WA_BACKUPS_DIR"] = "$safeOneDrivePath\\wa_backups"
$config["PBX_LOCAL_RECORDINGS_DIR"] = "$safeOneDrivePath\\pbx_recordings"
$config["OUTLOOK_BACKUPS_DIR"] = "$safeOneDrivePath\\outlook_backups"
$config["CALL_REPO_BACKUP_DIR"] = "$safeOneDrivePath\\call_backups"

# Defaults for database if not already present
if (-not $config.Contains("DB_NAME")) { $config["DB_NAME"] = "unicomm_db" }
if (-not $config.Contains("DB_USER")) { $config["DB_USER"] = "postgres" }
if (-not $config.Contains("DB_PASSWORD") -or $config["DB_PASSWORD"] -eq "your_password_here") { $config["DB_PASSWORD"] = "Unicircuit@2026" }
if (-not $config.Contains("DB_HOST")) { $config["DB_HOST"] = "localhost" }
if (-not $config.Contains("DB_PORT")) { $config["DB_PORT"] = "5432" }

# Write variables back to .env
$envContent = @()
$envContent += "# -- Generated by setup-tower.ps1 for Tower Server Deployment --"
foreach ($key in $config.Keys) {
    $envContent += "$key=$($config[$key])"
}

$envContent | Set-Content -Path $envPath -Encoding UTF8
Write-Host "Successfully generated backend/.env configuration." -ForegroundColor Green

# ── STEP 5: SSL Certificate Generation (Mandatory for Microsoft Graph) ──
Write-Host "`n[4/7] Generating modern self-signed SSL certificate (HTTPS)..." -ForegroundColor Yellow
$certsDir = Join-Path $backendDir "certs"
if (-not (Test-Path $certsDir)) {
    New-Item -ItemType Directory -Path $certsDir -Force | Out-Null
}

$certKey = Join-Path $certsDir "server.key"
$certCrt = Join-Path $certsDir "server.crt"

$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
if (-not (Test-Path $openssl)) {
    $openssl = Get-Command openssl -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
}

if ($openssl) {
    Write-Host "Using OpenSSL to generate modern certificates: $openssl" -ForegroundColor Gray
    & $openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout $certKey -out $certCrt -subj "/CN=192.168.0.205" 2>$null
    Write-Host "Self-signed certificate generated in backend/certs/" -ForegroundColor Green
} else {
    Write-Host "WARNING: OpenSSL was not found. Attempting to create certificate via PowerShell fallback..." -ForegroundColor Yellow
    # Self-signed certificate fallback via PowerShell
    $cert = New-SelfSignedCertificate -DnsName "192.168.0.205" -CertStoreLocation "cert:\LocalMachine\My" -NotAfter (Get-Date).AddYears(10)
    
    # Export certificate & private key (requires password)
    $pwd = ConvertTo-SecureString -String "unicomm" -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath (Join-Path $certsDir "server.pfx") -Password $pwd -Force | Out-Null
    
    Write-Host "Created fallback server.pfx. Generate node certificates using git OpenSSL to verify compatibility if backend crashes." -ForegroundColor Yellow
}

# ── STEP 6: Firewall Configuration ──
Write-Host "`n[5/7] Configuring Windows Defender Firewall rules..." -ForegroundColor Yellow
# Port 8088: CRM access
netsh advfirewall firewall add rule name="UniComm CRM 8088" dir=in action=allow protocol=TCP localport=8088 | Out-Null
# Port 5001: PBX incoming logs
netsh advfirewall firewall add rule name="Matrix PBX SMDR 5001" dir=in action=allow protocol=TCP localport=5001 | Out-Null
# Port 4000: PBX Click-to-dial CTI
netsh advfirewall firewall add rule name="Matrix PBX CTI 4000" dir=in action=allow protocol=TCP localport=4000 | Out-Null
Write-Host "Allowed inbound connections on ports 8088, 5001, and 4000." -ForegroundColor Green

# ── STEP 7: DB Schema & Startup Initialization ──
Write-Host "`n[6/7] Initializing database tables..." -ForegroundColor Yellow
try {
    # Switch to backend dir
    Set-Location $backendDir
    node db/init.js
    Write-Host "Database initialization completed successfully." -ForegroundColor Green
} catch {
    Write-Host "Database sync failed: Make sure PostgreSQL v16 is installed and running on Port 5432." -ForegroundColor Red
    Write-Host "Error details: $_" -ForegroundColor Red
}

# ── STEP 8: PM2 and Startup Orchestration ──
Write-Host "`n[7/7] Installing PM2 and setting up startup task..." -ForegroundColor Yellow
Set-Location $scriptRoot

# Install PM2 globally if missing
$pm2Path = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2Path) {
    Write-Host "PM2 process manager not found. Installing globally via npm..." -ForegroundColor Gray
    npm install -g pm2
}

# Clean any existing instances
Write-Host "Stopping any existing PM2 processes..." -ForegroundColor Gray
pm2 delete all 2>$null | Out-Null

# Start services using the ecosystem.config.js file
Write-Host "Starting UniComm CRM & n8n via PM2 ecosystem..." -ForegroundColor Gray
pm2 start ecosystem.config.js
pm2 save

# Create a Startup Task to automatically restore processes on system reboot
Write-Host "Registering PM2 startup scheduled task..." -ForegroundColor Gray
$action = New-ScheduledTaskAction -Execute "pm2" -Argument "resurrect" -WorkingDirectory $scriptRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
# Run as SYSTEM so it launches silently even if no user is logged in
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName "PM2-UniComm" -Description "Auto-start PM2 services on system boot" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "PM2 Windows Startup Task registered successfully." -ForegroundColor Green

Write-Host "`n=========================================================" -ForegroundColor Green
Write-Host "             SETUP COMPLETED SUCCESSFULLY!                " -ForegroundColor Green
Write-Host "=========================================================" -ForegroundColor Green
Write-Host "You can access the CRM locally at: https://localhost:8088" -ForegroundColor Gray
Write-Host "Or on the LAN network at: https://192.168.0.205:8088" -ForegroundColor Gray
Write-Host "All media files and backups are redirected to your OneDrive folder." -ForegroundColor Gray
Write-Host "=========================================================" -ForegroundColor Green
