# UniComm Pro — Deployment & Maintenance Guide

---

## Tower Server Info
- **IP:** 192.168.0.205
- **Port:** 8088
- **URL:** http://192.168.0.205:8088
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
MS_REDIRECT_URI=http://192.168.0.205:8088/auth/callback
MS_USER_EMAIL=sales@unicircuites.com
APP_PUBLIC_URL=http://192.168.0.205:8088
ENGAGEBAY_API_KEY=your_engagebay_api_key_here
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=noreply@unicircuites.live
SMTP_PASS=V&z7GfwMNy4pVm&
SMTP_FROM=noreply@unicircuites.live
SMTP_FROM_NAME=Unicircuit Engineering Services LLP
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

## Update Server (Pull latest from GitHub)

Dev machine pe changes karo → GitHub pe push karo → Tower pe run karo:

```powershell
powershell -ExecutionPolicy Bypass -File C:\update-unicomm.ps1
```

### Update script banane ka command (ek baar)
```powershell
@"
Write-Host "Downloading latest code..." -ForegroundColor Cyan
Invoke-WebRequest -Uri 'https://github.com/unicircuites/Unicircuit_UniComm/archive/refs/heads/main.zip' -Headers @{Authorization='token GITHUB_TOKEN_HERE'} -OutFile 'C:\UniComm_update.zip'

Write-Host "Extracting..." -ForegroundColor Cyan
Expand-Archive -Path 'C:\UniComm_update.zip' -DestinationPath 'C:\UniComm_update' -Force

Write-Host "Copying files (keeping .env)..." -ForegroundColor Cyan
Copy-Item -Path 'C:\UniComm_update\Unicircuit_UniComm-main\*' -Destination 'C:\UniComm\Unicircuit_UniComm-main\' -Recurse -Force -Exclude '.env'

Write-Host "Installing dependencies..." -ForegroundColor Cyan
Set-Location 'C:\UniComm\Unicircuit_UniComm-main\backend'
npm install

Write-Host "Restarting server..." -ForegroundColor Cyan
pm2 restart unicomm

Write-Host "Cleaning up..." -ForegroundColor Cyan
Remove-Item 'C:\UniComm_update.zip' -Force
Remove-Item 'C:\UniComm_update' -Recurse -Force

Write-Host "Done! Server updated and restarted." -ForegroundColor Green
pm2 status
"@ | Set-Content -Path "C:\update-unicomm.ps1" -Encoding UTF8
```

> **Note:** `GITHUB_TOKEN_HERE` ki jagah apna GitHub Personal Access Token daalo.
> Token banane ka link: https://github.com/settings/tokens/new
> Scope: `repo` only

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
5. Tower pe: powershell -ExecutionPolicy Bypass -File C:\update-unicomm.ps1
```
