# UniComm Pro — Tower Server Prerequisite Installer & Bootstrap Script
# Copy this script to the Tower Server, open PowerShell as Administrator, and run it.
# Usage: powershell -ExecutionPolicy Bypass -File .\bootstrap-tower.ps1

# ── STEP 1: Verify Administrator Privileges ──
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script MUST be run as an Administrator. Please run PowerShell as Administrator and try again."
    Exit
}

$tempDir = "C:\UniComm_Setup_Temp"
if (-not (Test-Path $tempDir)) {
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
}

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "     UniComm Pro Tower Server Bootstrap & Prerequisites  " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "This script will download and install Node.js, Git, and PostgreSQL,"
Write-Host "then download the latest UniComm code and set it up automatically.`n"

# ── STEP 2: Check and Install Node.js ──
$nodeInstalled = Get-Command node -ErrorAction SilentlyContinue
if ($nodeInstalled) {
    Write-Host "[✓] Node.js is already installed: $($nodeInstalled.Source)" -ForegroundColor Green
} else {
    Write-Host "[ ] Node.js not found. Downloading Node.js LTS installer..." -ForegroundColor Yellow
    $nodeUrl = "https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi"
    $nodeMsi = Join-Path $tempDir "node-installer.msi"
    
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi
    
    Write-Host "Installing Node.js silently... (Please wait)" -ForegroundColor Gray
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn /norestart" -Wait
    
    # Reload environment path to pick up Node
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Host "[✓] Node.js installed successfully." -ForegroundColor Green
    } else {
        Write-Warning "Node.js installation completed, but 'node' is not in the system Path yet. You may need to restart PowerShell after setup."
    }
}

# ── STEP 3: Check and Install Git ──
$gitInstalled = Get-Command git -ErrorAction SilentlyContinue
if ($gitInstalled) {
    Write-Host "[✓] Git is already installed: $($gitInstalled.Source)" -ForegroundColor Green
} else {
    Write-Host "[ ] Git not found. Downloading Git for Windows..." -ForegroundColor Yellow
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.43.0.windows.1/Git-2.43.0-64-bit.exe"
    $gitExe = Join-Path $tempDir "git-installer.exe"
    
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitExe
    
    Write-Host "Installing Git silently... (Please wait)" -ForegroundColor Gray
    Start-Process $gitExe -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP-" -Wait
    
    # Reload environment path
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Host "[✓] Git installed successfully." -ForegroundColor Green
    } else {
        Write-Warning "Git installation completed, but 'git' is not in system Path yet."
    }
}

# ── STEP 4: Check and Install PostgreSQL 16 ──
# Check if PostgreSQL service exists
$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
if ($pgService) {
    Write-Host "[✓] PostgreSQL service is already registered: $($pgService.DisplayName)" -ForegroundColor Green
} else {
    Write-Host "[ ] PostgreSQL not found. Downloading PostgreSQL 16 Windows x64..." -ForegroundColor Yellow
    $pgUrl = "https://get.enterprisedb.com/postgresql/postgresql-16.2-1-windows-x64.exe"
    $pgExe = Join-Path $tempDir "postgres-installer.exe"
    
    try {
        Invoke-WebRequest -Uri $pgUrl -OutFile $pgExe -TimeoutSec 300
    } catch {
        Write-Error "Failed to download PostgreSQL installer. Please download and install PostgreSQL 16 manually from: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads"
        Write-Host "Once PostgreSQL is installed, re-run this script to continue."
        Exit
    }
    
    Write-Host "Installing PostgreSQL 16 silently... Database password will be 'Unicircuit@2026'" -ForegroundColor Gray
    # Silent install arguments for EnterpriseDB postgres installer
    $pgArgs = "--mode unattended --superpassword `"Unicircuit@2026`""
    Start-Process $pgExe -ArgumentList $pgArgs -Wait
    
    $pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
    if ($pgService) {
        Write-Host "[✓] PostgreSQL installed and service started successfully." -ForegroundColor Green
    } else {
        Write-Warning "PostgreSQL installer finished, but service was not found. Please install manually if db initialization fails."
    }
}

# ── STEP 5: Check and Install Python ──
$pythonInstalled = Get-Command python -ErrorAction SilentlyContinue
if ($pythonInstalled) {
    Write-Host "[✓] Python is already installed: $($pythonInstalled.Source)" -ForegroundColor Green
} else {
    Write-Host "[ ] Python not found. Downloading Python 3.11 installer..." -ForegroundColor Yellow
    $pythonUrl = "https://www.python.org/ftp/python/3.11.8/python-3.11.8-amd64.exe"
    $pythonExe = Join-Path $tempDir "python-installer.exe"
    
    Invoke-WebRequest -Uri $pythonUrl -OutFile $pythonExe
    
    Write-Host "Installing Python silently... (Please wait)" -ForegroundColor Gray
    Start-Process $pythonExe -ArgumentList "/quiet InstallAllUsers=1 PrependPath=1" -Wait
    
    # Reload environment path
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
    if (Get-Command python -ErrorAction SilentlyContinue) {
        Write-Host "[✓] Python installed successfully." -ForegroundColor Green
    } else {
        Write-Warning "Python installation completed, but 'python' is not in system Path yet."
    }
}

# ── STEP 6: Clone / Download Codebase from GitHub ──
Write-Host "`n[ ] Downloading UniComm codebase from GitHub..." -ForegroundColor Yellow
$targetDeployDir = "C:\UniComm"
if (-not (Test-Path $targetDeployDir)) {
    New-Item -ItemType Directory -Path $targetDeployDir -Force | Out-Null
}

$tokenInput = Read-Host "Enter your GitHub Personal Access Token (PAT) to download the private repository"
if ([string]::IsNullOrWhiteSpace($tokenInput)) {
    Write-Error "GitHub token is required to pull the private repository code."
    Exit
}

$zipUrl = "https://github.com/unicircuites/Unicircuit_UniComm/archive/refs/heads/main.zip"
$zipPath = Join-Path $tempDir "UniComm.zip"

Write-Host "Downloading codebase zip file..." -ForegroundColor Gray
try {
    $headers = @{
        "Authorization" = "token $tokenInput"
    }
    Invoke-WebRequest -Uri $zipUrl -Headers $headers -OutFile $zipPath -TimeoutSec 120
    Write-Host "Download complete." -ForegroundColor Green
} catch {
    Write-Error "Failed to download codebase zip from GitHub. Verify your Personal Access Token is valid and has repository read permissions."
    Exit
}

Write-Host "Extracting archive to $targetDeployDir..." -ForegroundColor Gray
Expand-Archive -Path $zipPath -DestinationPath $targetDeployDir -Force

# Locate the extracted folder
$extractedFolder = Get-ChildItem -Path $targetDeployDir -Filter "Unicircuit_UniComm-*" | Select-Object -First 1
if (-not $extractedFolder) {
    Write-Error "Could not locate the extracted repository folder inside $targetDeployDir."
    Exit
}

$repoPath = $extractedFolder.FullName
Write-Host "Codebase extracted successfully to: $repoPath" -ForegroundColor Green

# ── STEP 7: Execute Setup and Start ──
Write-Host "`n[ ] Launching setup-tower.ps1 to configure the application..." -ForegroundColor Yellow
$setupScriptPath = Join-Path $repoPath "setup-tower.ps1"

if (Test-Path $setupScriptPath) {
    # Run the setup script in the active shell context
    Set-Location $repoPath
    powershell -ExecutionPolicy Bypass -File .\setup-tower.ps1
} else {
    Write-Error "Could not locate setup-tower.ps1 in the extracted repository at $setupScriptPath."
    Exit
}

# ── STEP 8: Cleanup ──
Write-Host "`n[ ] Cleaning up temporary installation files..." -ForegroundColor Yellow
try {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Cleanup completed." -ForegroundColor Green
} catch {
    Write-Host "Some temporary setup files in $tempDir could not be deleted; you can remove them manually." -ForegroundColor Gray
}

Write-Host "`n=========================================================" -ForegroundColor Green
Write-Host "         BOOTSTRAP INSTALLATION COMPLETED!                " -ForegroundColor Green
Write-Host "=========================================================" -ForegroundColor Green
Write-Host "You can now test the server at: https://192.168.0.55:8088" -ForegroundColor Gray
Write-Host "=========================================================" -ForegroundColor Green
