# UniComm Pro — Deployment & Maintenance Guide

---

## Tower Server Info
- **IP:** 192.168.0.205
- **Port:** 8088
- **URL:** https://192.168.0.205:8088
- **Project Path:** `C:\UniComm\Unicircuit_UniComm-main`
- **OS:** Windows
- **Node:** v24+
- **PostgreSQL:** v16
- **Process Manager:** PM2

---

## Login Credentials
| Type | Username | Password |
|---|---|---|
| App Admin | `Uniadmin` | `Uniadmin@123` |
| App Demo | `demo@unicircuit.com` | `Demo@1234` |
| PostgreSQL | `postgres` | `Unicircuit@2026` |

---

## First Time Deployment (Fresh Server)

### 1. Download code from GitHub
```powershell
powershell -Command "Invoke-WebRequest -Uri 'https://github.com/unicircuites/Unicircuit_UniComm/archive/refs/heads/main.zip' -Headers @{Authorization='token GITHUB_TOKEN_HERE'} -OutFile 'C:\UniComm.zip'"
powershell -Command "Expand-Archive -Path 'C:\UniComm.zip' -DestinationPath 'C:\UniComm' -Force"
cd C:\UniComm\Unicircuit_UniComm-main\backend
```

### 2. Install dependencies
```powershell
npm install
```

### 3. Create .env file
```powershell
@"
DB_HOST=localhost
DB_PORT=5432
DB_NAME=unicircuit_db
DB_USER=postgres
DB_PASSWORD=Unicircuit@2026
JWT_SECRET=unicomm_super_secret_jwt_key_change_me_in_production
PORT=8088
HOST=0.0.0.0
NODE_ENV=production
PBX_HOST=192.168.0.81
SMDR_PORT=5000
CTI_PORT=5001
MS_TENANT_ID=407ec761-e4ad-4d41-9ea4-6ae7fe391047
MS_CLIENT_ID=d6224f70-6728-4f68-93aa-75a91f4adaa8
MS_CLIENT_SECRET=nzF8Q~v7eZui9WgYylxIebCoD2hCjzWao6gDpazR
MS_REDIRECT_URI=https://192.168.0.205:8088/auth/callback
MS_USER_EMAIL=sales@unicircuites.com
APP_PUBLIC_URL=https://192.168.0.205:8088
ENGAGEBAY_API_KEY=your_engagebay_api_key_here
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=noreply@unicircuites.live
SMTP_PASS=V&z7GfwMNy4pVm&
SMTP_FROM=noreply@unicircuites.live
SMTP_FROM_NAME=Unicircuit Engineering Services LLP
AI_API_HOST=https://api.groq.com/openai/v1
AI_API_MODEL=llama-3.1-8b-instant
AI_API_KEY=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
WA_WATCHDOG_ENABLED=true
WA_WATCHDOG_INTERVAL_MS=45000
WA_STALE_RESTART_MS=180000
"@ | Set-Content -Path "C:\UniComm\Unicircuit_UniComm-main\backend\.env" -Encoding UTF8
```

### 4. Initialize Database (first time only)
```powershell
node db/init.js
```
> If error "foreign key constraint": run this first then retry:
> ```powershell
> psql -U postgres -d unicircuit_db -c "DROP TABLE IF EXISTS audit_log, campaigns, call_logs, pipeline_deals, contacts, users CASCADE;"
> ```

### 5. Install PM2 and start server
```powershell
npm install -g pm2
pm2 start server.js --name unicomm
pm2 save
```

### 6. Auto-start on Windows reboot
```powershell
$action = New-ScheduledTaskAction -Execute "pm2" -Argument "resurrect" -WorkingDirectory "C:\UniComm\Unicircuit_UniComm-main\backend"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "pbaro" -RunLevel Highest
Register-ScheduledTask -TaskName "PM2-UniComm" -Action $action -Trigger $trigger -Principal $principal -Force
```

### 7. Allow port through Windows Firewall
```powershell
netsh advfirewall firewall add rule name="UniComm 8088" dir=in action=allow protocol=TCP localport=8088
```

---

## HTTPS Requirement & SSL Setup (MANDATORY)

The Tower server **MUST** run on HTTPS for Microsoft Graph (Outlook) authentication to work. If HTTPS is not configured, the login will fail.

### 1. SSL Certificate Location
Certificates must be placed in:
`C:\UniComm\Unicircuit_UniComm-main\backend\certs\`

Required files:
- `server.crt`
- `server.key`

### 2. How to Generate Self-Signed Cert
Newer versions of Node.js (20+) block legacy Windows certificate encryption formats. Use Git's built-in OpenSSL to generate modern, Node-compatible certificates.

Run this in PowerShell on the Tower server:
```powershell
mkdir -Path "C:\UniComm\Unicircuit_UniComm-main\backend\certs" -ErrorAction SilentlyContinue
& "C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout "C:\UniComm\Unicircuit_UniComm-main\backend\certs\server.key" -out "C:\UniComm\Unicircuit_UniComm-main\backend\certs\server.crt" -subj "/CN=192.168.0.205"
```

---

## Update Server (Pull latest from GitHub)

Dev machine pe changes karo → GitHub pe push karo → Tower pe run karo:

> **BRANCH SAFETY - READ FIRST**
> - Production feature line is `main`, currently based on the autosave/PBX call-log work.
> - Do **not** force-push `main` from an old branch/history.
> - Before pushing `main`, verify these commits/features exist in history:
>   - `feat(pbx): add network drive integration and paginated recursive recording sync`
>   - PBX call logs UI/API changes in `dashboard.html`, `backend/routes/calls.js`, `backend/services/matrixSmdr.js`
>   - backup files under `backups/call_logs/`
> - If `main` accidentally loses these features, restore from `origin/autosave` or the latest known good autosave commit before deploying Tower.

```powershell
powershell -ExecutionPolicy Bypass -File C:\update-unicomm.ps1
```

> **IMPORTANT:** Tower server ke local files delete/stash mat karo:
> - `backend\.env`
> - `backend\certs\server.crt`
> - `backend\certs\server.key`
>
> Agar cert files missing ho gayi to PM2 process start hote hi crash karega:
> `ENOENT: no such file or directory, open '...\backend\certs\server.crt'`

### Update script banane ka command (ek baar)
```powershell
@"
Write-Host "Downloading latest code..." -ForegroundColor Cyan
Invoke-WebRequest -Uri 'https://github.com/unicircuites/Unicircuit_UniComm/archive/refs/heads/main.zip' -Headers @{Authorization='token GITHUB_TOKEN_HERE'} -OutFile 'C:\UniComm_update.zip'

Write-Host "Extracting..." -ForegroundColor Cyan
Expand-Archive -Path 'C:\UniComm_update.zip' -DestinationPath 'C:\UniComm_update' -Force

Write-Host "Backing up server-local files (.env + certs)..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path 'C:\UniComm_server_backup' -Force | Out-Null
if (Test-Path 'C:\UniComm\Unicircuit_UniComm-main\backend\.env') {
  Copy-Item 'C:\UniComm\Unicircuit_UniComm-main\backend\.env' 'C:\UniComm_server_backup\.env' -Force
}
if (Test-Path 'C:\UniComm\Unicircuit_UniComm-main\backend\certs') {
  Copy-Item 'C:\UniComm\Unicircuit_UniComm-main\backend\certs' 'C:\UniComm_server_backup\certs' -Recurse -Force
}

Write-Host "Copying files..." -ForegroundColor Cyan
Copy-Item -Path 'C:\UniComm_update\Unicircuit_UniComm-main\*' -Destination 'C:\UniComm\Unicircuit_UniComm-main\' -Recurse -Force

Write-Host "Restoring server-local files (.env + certs)..." -ForegroundColor Cyan
if (Test-Path 'C:\UniComm_server_backup\.env') {
  Copy-Item 'C:\UniComm_server_backup\.env' 'C:\UniComm\Unicircuit_UniComm-main\backend\.env' -Force
}
if (Test-Path 'C:\UniComm_server_backup\certs') {
  Copy-Item 'C:\UniComm_server_backup\certs' 'C:\UniComm\Unicircuit_UniComm-main\backend\certs' -Recurse -Force
}

Write-Host "Installing dependencies..." -ForegroundColor Cyan
Set-Location 'C:\UniComm\Unicircuit_UniComm-main\backend'
npm install

Write-Host "Restarting server..." -ForegroundColor Cyan
if (pm2 describe unicomm | Select-String "status") {
  pm2 restart unicomm --update-env
} else {
  pm2 start server.js --name unicomm --update-env
  pm2 save
}

Write-Host "Cleaning up..." -ForegroundColor Cyan
Remove-Item 'C:\UniComm_update.zip' -Force
Remove-Item 'C:\UniComm_update' -Recurse -Force

Write-Host "Done! Server updated and restarted." -ForegroundColor Green
pm2 status
```

> **Note:** `git stash` saves any local changes on Tower server before pulling.
> If you want to see what was stashed: `git stash list`
> To restore stashed changes: `git stash pop`

### Manual Git update (agar script use nahi kar rahe)

```powershell
cd C:\UniComm\Unicircuit_UniComm-main

# Sirf tracked local changes stash karo. -u mat lagao, warna certs jaise untracked server files stash ho sakte hain.
git stash push -m "tower tracked changes before deploy"

git checkout main
git fetch origin
git reset --hard origin/main

cd backend
npm install

if (Test-Path .\certs\server.crt) {
  pm2 restart unicomm --update-env
  pm2 status
} else {
  Write-Host "ERROR: backend\certs\server.crt missing. Restore certs before restarting PM2." -ForegroundColor Red
}
```

### Restore certs if they were accidentally stashed

```powershell
cd C:\UniComm\Unicircuit_UniComm-main
git stash list
git stash show --name-only "stash@{0}"
git checkout "stash@{0}" -- backend/certs

# Agar certs untracked the aur git stash push -u se stash hue the, yeh use karo:
git ls-tree -r --name-only "stash@{0}^3"
git checkout "stash@{0}^3" -- backend/certs

cd backend
pm2 restart unicomm --update-env
pm2 status
```

---

## PM2 Commands

```powershell
pm2 status              # server running hai ya nahi
pm2 logs unicomm        # live logs dekho
pm2 restart unicomm     # restart karo
pm2 stop unicomm        # band karo
pm2 start unicomm       # start karo
```

---

## PostgreSQL — Password Reset (agar bhool jao)

```powershell
net stop postgresql-x64-16
(Get-Content "C:\Program Files\PostgreSQL\16\data\pg_hba.conf") -replace 'scram-sha-256','trust' | Set-Content "C:\Program Files\PostgreSQL\16\data\pg_hba.conf"
net start postgresql-x64-16
psql -U postgres -c "ALTER USER postgres WITH PASSWORD 'Unicircuit@2026';"
(Get-Content "C:\Program Files\PostgreSQL\16\data\pg_hba.conf") -replace 'trust','scram-sha-256' | Set-Content "C:\Program Files\PostgreSQL\16\data\pg_hba.conf"
net stop postgresql-x64-16; net start postgresql-x64-16
```

---

## PBX SMDR Setup

### Architecture
```
Matrix PBX (192.168.0.81)
    ↓ TCP SMDR push to whichever server is set in PBX
Dev Machine (192.168.0.149:5001)  OR  Tower (192.168.0.205:5001)
    ↓
Tower PostgreSQL DB (192.168.0.205:5432)  ← both use same DB
```

### PBX Settings (SMDR Online page)
Advanced Settings → SMDR → SMDR Online  
All three sections (Outgoing / Incoming / Internal):

| Field | Dev Testing | Tower Production |
|---|---|---|
| Destination IP | `192.168.0.149` | `192.168.0.205` |
| Port | `5001` | `5001` |
| Mode | Ethernet | Ethernet |

### Dev Machine .env
```
DB_HOST=192.168.0.205
DB_PORT=5432
DB_NAME=unicircuit_db
DB_USER=postgres
DB_PASSWORD=Unicircuit@2026
SMDR_PORT=5001
PBX_HOST=192.168.0.81
```

### Tower .env
```
DB_HOST=localhost
SMDR_PORT=5001
PBX_HOST=192.168.0.81
```

### Tower PostgreSQL Remote Access (run ONCE on tower)
```powershell
Add-Content "C:\Program Files\PostgreSQL\16\data\pg_hba.conf" "`nhost    all             all             192.168.0.0/24          scram-sha-256"
(Get-Content "C:\Program Files\PostgreSQL\16\data\postgresql.conf") -replace "#listen_addresses = 'localhost'", "listen_addresses = '*'" | Set-Content "C:\Program Files\PostgreSQL\16\data\postgresql.conf"
net stop postgresql-x64-16; net start postgresql-x64-16
```

---

## Outlook / Microsoft Graph — Azure Setup

### Application Permissions (user login ke bina kaam kare)

1. Azure Portal → App registrations → **UniComm**
2. **API Permissions** → Add a permission → Microsoft Graph → **Application permissions**
3. Yeh permissions add karo:
   - `Mail.Read`
   - `Mail.Send`
   - `Mail.ReadWrite`
   - `Contacts.Read`
4. **"Grant admin consent for Unicircuit"** button dabao ✅

### Azure App Details
| Field | Value |
|---|---|
| App Name | UniComm |
| Tenant ID | `407ec761-e4ad-4d41-9ea4-6ae7fe391047` |
| Client ID | `d6224f70-6728-4f68-93aa-75a91f4adaa8` |
| Redirect URI (Web) | `http://localhost:8088/auth/callback` |
| Redirect URI (Web) | `https://192.168.0.205:8088/auth/callback` |
| Mailbox | `sales@unicircuites.com` |

> **Azure Redirect URI Rules (important):**
> - `http://` — sirf `localhost` ke saath allowed hai
> - `http://` — kisi bhi IP/domain ke saath **NOT allowed**
> - `https://` — kisi bhi IP/domain ke saath allowed hai
>
> **Matlab:** Tower server pe Outlook connect karne ke liye **HTTPS** mandatory hai.
> SSL certificate setup karo (self-signed bhi chalega) aur `.env` mein update karo:
> ```
> MS_REDIRECT_URI=https://192.168.0.205:8088/auth/callback
> APP_PUBLIC_URL=https://192.168.0.205:8088
> ```

---

## Outlook Reconnect — Azure se Logout ho gaye / Token expire ho gaya

Yeh tab karna padta hai jab:
- Dashboard pe Outlook status **"Not Connected"** dikhe
- Emails load na ho rahe ho
- Server logs mein `NOT_AUTHENTICATED` ya `Refresh token failed` dikhe
- Azure pe manually logout kiya ho ya client secret change kiya ho

---

### Step 1 — Check karo kya problem hai

Server logs dekho:
```powershell
pm2 logs unicomm --lines 50
```

Kya dikhe:
| Log message | Matlab |
|---|---|
| `Refresh token failed` | Refresh token expire / revoked — re-login karna padega |
| `Client credentials failed` | Azure app permissions ya admin consent missing |
| `NOT_AUTHENTICATED` | Koi bhi token nahi mila — re-login karo |
| `AADSTS700016` | Client ID is tenant mein registered nahi |
| `AADSTS7000215` | Client Secret galat ya expire ho gaya |
| `AADSTS50011` | Redirect URI mismatch — Azure mein check karo |

---

### Step 2 — Dashboard se reconnect karo (sabse pehle yeh try karo)

1. Browser mein kholo: `http://192.168.0.205:8088/dashboard.html`
2. Login karo (Uniadmin / Uniadmin@123)
3. **Email / Outlook** tab pe jao
4. **"Connect Outlook"** button dhundo — click karo
5. Microsoft login page khulega → `sales@unicircuites.com` se login karo
6. Permissions accept karo
7. Redirect hoga back to dashboard — "Outlook Connected!" dikhe

> Agar "Connect Outlook" button nahi dikh raha — status already connected show ho raha hai lekin kaam nahi kar raha — toh Step 3 karo.

---

### Step 3 — DB se purana token delete karo (force re-auth)

```powershell
psql -U postgres -d unicircuit_db -c "DELETE FROM ms_tokens WHERE user_email = 'sales@unicircuites.com';"
```

Phir Step 2 dobara karo.

---

### Step 4 — Client Secret expire ho gaya (Azure pe naya banao)

1. **Azure Portal** → https://portal.azure.com
2. **App registrations** → **UniComm** app dhundo
3. **Certificates & secrets** → **Client secrets** tab
4. Purana secret ka expiry date dekho — agar expire ho gaya hai:
   - **+ New client secret** click karo
   - Description: `UniComm-2026` (ya koi bhi naam)
   - Expiry: **24 months** select karo
   - **Add** click karo
5. **Value** copy karo (sirf ek baar dikhta hai — abhi copy karo!)
6. Tower pe `.env` update karo:

```powershell
# Pehle current value dekho
Get-Content C:\UniComm\Unicircuit_UniComm-main\backend\.env | Select-String "MS_CLIENT_SECRET"

# Naya secret set karo (PASTE_NEW_SECRET_HERE ki jagah actual value daalo)
(Get-Content C:\UniComm\Unicircuit_UniComm-main\backend\.env) `
  -replace 'MS_CLIENT_SECRET=.*', 'MS_CLIENT_SECRET=PASTE_NEW_SECRET_HERE' `
  | Set-Content C:\UniComm\Unicircuit_UniComm-main\backend\.env -Encoding UTF8

# Server restart karo
pm2 restart unicomm
```

7. Phir **Step 2** (Dashboard se reconnect) karo.

---

### Step 5 — Redirect URI mismatch fix karo

Agar Azure login ke baad error aaye: *"The reply URL specified in the request does not match"*

1. Azure Portal → App registrations → UniComm
2. **Authentication** tab
3. **Web → Redirect URIs** mein yeh dono hone chahiye:
   ```
   http://localhost:8088/auth/callback
   http://192.168.0.205:8088/auth/callback
   ```
4. Agar missing hai → **Add URI** → save karo
5. Phir Step 2 dobara karo

---

### Step 6 — Admin Consent missing (Client Credentials kaam nahi kar raha)

Agar delegated login ke baad bhi emails nahi aa rahe, ya `Client credentials failed` log mein dikhe:

1. Azure Portal → App registrations → UniComm
2. **API Permissions** tab
3. Yeh **Application permissions** hone chahiye (not Delegated):
   - `Mail.Read` ✅
   - `Mail.Send` ✅
   - `Mail.ReadWrite` ✅
   - `Contacts.Read` ✅
4. **"Grant admin consent for Unicircuit Engineering Services LLP"** button dabao
5. Confirm karo — sab permissions ke aage green tick aana chahiye

---

### Quick Reconnect Checklist

```
[ ] pm2 logs mein error type identify kiya
[ ] DB se purana token delete kiya (Step 3)
[ ] Dashboard → Connect Outlook → Microsoft login complete kiya
[ ] "Outlook Connected!" page dikha
[ ] Dashboard pe inbox load ho raha hai
```

Agar yeh sab karne ke baad bhi kaam nahi kar raha:
```powershell
# Full debug — server restart with fresh logs
pm2 stop unicomm
pm2 flush unicomm
pm2 start unicomm
pm2 logs unicomm --lines 100
```
Logs mein `[Graph]` aur `[MSAL]` lines dekho — exact error wahan hoga.

---

## GitHub Repository
- **URL:** https://github.com/unicircuites/Unicircuit_UniComm
- **Branch:** `main`
- **Private repo** — GitHub token required for download

---

## Dev Machine Workflow
```
1. Code changes karo (VS Code / Kiro)
2. git add -A
3. git commit -m "message"
4. git push origin main
5. Tower pe: neeche wale commands run karo
```

---

## 🚀 Tower Server — Git Pull & Deploy (Run These Commands)

> **Copy-paste these commands directly into Tower server PowerShell (as Administrator).**
> `.env` aur `certs/` kabhi delete nahi honge — yeh commands unhe touch nahi karte.

---

### 📋 Recent Deploy Notes

| Date | Commit | What Changed | Special Steps |
|---|---|---|---|
| 01-Jun-2026 | `cfeff91` | Added Power Generation PSU + State PSU email templates (2 new banner presets, 2 new seed templates, dashboard dropdowns updated) | **Re-seed email templates after deploy** — run `node db/seedEmailTemplates.js` (or `node db/init.js` if no separate seed script) from the `backend/` folder |
| 01-Jun-2026 | `273acd5` | Sync line endings, updated image.png, added `scripts/sync-email-templates.js` | No special steps — standard pull + restart |



### Step 1 — Project folder pe jao
```powershell
cd C:\UniComm\Unicircuit_UniComm-main
```

### Step 2 — Tracked local changes stash karo (safe)
```powershell
git stash push -m "tower tracked changes before deploy"
```

### Step 3 — Latest code GitHub se pull karo
```powershell
git checkout main
git fetch origin
git reset --hard origin/main
```

### Step 4 — Backend dependencies update karo
```powershell
cd backend
npm install --prefer-offline
```

### Step 5 — SSL certs check karo (auto-generate if missing)
```powershell
mkdir certs -ErrorAction SilentlyContinue
if (!(Test-Path ".\certs\server.key") -or !(Test-Path ".\certs\server.crt")) {
  Write-Host "SSL certs missing — generating..." -ForegroundColor Yellow
  & "C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -nodes -days 3650 -newkey rsa:2048 `
    -keyout ".\certs\server.key" -out ".\certs\server.crt" -subj "/CN=192.168.0.205"
} else {
  Write-Host "SSL certs OK" -ForegroundColor Green
}
```

### Step 6 — Server restart karo
```powershell
pm2 restart unicomm --update-env
pm2 save
```

### Step 7 — Logs flush karo aur verify karo
```powershell
pm2 flush unicomm
pm2 status
pm2 logs unicomm --lines 80
```

---

### ⚡ One-liner (sab ek saath — copy-paste ready)

```powershell
cd C:\UniComm\Unicircuit_UniComm-main; git stash push -m "tower deploy stash"; git checkout main; git fetch origin; git reset --hard origin/main; cd backend; npm install --prefer-offline; pm2 restart unicomm --update-env; pm2 save; pm2 flush unicomm; pm2 status
```

---

### ✅ Deploy Checklist

```
[ ] cd C:\UniComm\Unicircuit_UniComm-main
[ ] git stash push -m "tower tracked changes before deploy"
[ ] git fetch origin
[ ] git reset --hard origin/main
[ ] cd backend && npm install --prefer-offline
[ ] certs\ folder mein server.crt aur server.key exist karte hain
[ ] pm2 restart unicomm --update-env
[ ] pm2 status → "online" dikha
[ ] pm2 logs unicomm --lines 80 → koi crash nahi
[ ] Browser: https://192.168.0.205:8088 → dashboard load hua
```

---

### ⚠️ Agar git reset ke baad certs chali gayi

```powershell
# certs/ gitignore mein hai isliye reset se delete nahi honi chahiye.
# Agar phir bhi missing ho:
cd C:\UniComm\Unicircuit_UniComm-main\backend
mkdir certs -ErrorAction SilentlyContinue
& "C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -nodes -days 3650 -newkey rsa:2048 `
  -keyout ".\certs\server.key" -out ".\certs\server.crt" -subj "/CN=192.168.0.205"
pm2 restart unicomm --update-env
```

---

### ⚠️ Agar git stash se kuch restore karna ho

```powershell
git stash list                          # stash list dekho
git stash pop                           # latest stash restore karo
# ya specific stash:
git stash apply "stash@{0}"
```

---

## Git Installation Path (Found locally)

If `git` is not recognized on the development machine, it might be installed in the local AppData folder instead of Program Files.
The path found locally during a previous session was:
`C:\Users\unius\AppData\Local\Programs\Git\cmd\git.exe`

You can use the PowerShell variable `$env:LOCALAPPDATA\Programs\Git\cmd\git.exe` to run it.
