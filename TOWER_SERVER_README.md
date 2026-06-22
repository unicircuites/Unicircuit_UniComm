# 🚀 UniComm Pro — Tower Server Quick Start & Setup Guide

This guide describes how to deploy the UniComm Pro CRM and n8n services on your freshly formatted **Tower Server (IP: 192.168.0.200)** from scratch.

---

## 📋 Prerequisites
Before you start, make sure you have:
1. **Administrator access** to the Tower Server.
2. A **GitHub Personal Access Token (PAT)** with repository read access (required to download the private codebase).
3. **OneDrive** configured or a target storage drive mapped on the server where you want to keep the media logs.

---

## ⚡ Step-by-Step Installation

### Step 1: Copy the Bootstrap Script to the Server
1. Copy the file `bootstrap-tower.ps1` from this laptop.
2. Connect to the Tower Server via Remote Desktop (RDP).
3. Paste the file directly onto the Tower Server (e.g., on the `C:\` drive or Desktop).

### Step 2: Run the Installer as Administrator
1. On the Tower Server, click the Start menu, type **PowerShell**, right-click it, and select **Run as Administrator**.
2. Navigate to the folder where you pasted `bootstrap-tower.ps1`:
   ```powershell
   cd C:\
   ```
3. Run the installer:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\bootstrap-tower.ps1
   ```
4. The installer will prompt you to:
   * **Configure OneDrive Path**: Set where your high-volume media files should be saved (Default: `C:\Users\<user>\OneDrive\UniComm_Storage`).
   * **Enter your GitHub PAT**: Paste your token to authenticate download of the private codebase.

*The installer will automatically download, install and configure: Node.js, Git, PostgreSQL 16, Python, project packages, SSL certificate, firewall rules, and startup tasks.*

---

## 🛠️ Post-Installation Verification

Once the setup script finishes, verify the services are running correctly:

### 1. Check Service Status
Run this in PowerShell to see if PM2 is running the CRM backend and n8n:
```powershell
pm2 status
```
*Expected Output:*
* `unicomm-backend` — **online**
* `n8n` — **online**

### 2. Verify Client Browser Access
Open your web browser (on the server or any PC on the same network) and go to:
* **UniComm CRM Portal**: `https://192.168.0.200:8088`
* **n8n Automation Console**: `http://localhost:5678`

> [!NOTE]
> Since we use a self-signed SSL certificate for network security, your browser will show an **"Unsafe Connection / Certificate Invalid"** warning the first time you load the page. Click **Advanced** ⮕ **Proceed to 192.168.0.200 (unsafe)** to open the dashboard. This is normal and expected for local servers.

---

## ⚙️ Operational Commands (Cheatsheet)

Run these commands inside `C:\UniComm\Unicircuit_UniComm-main` to manage the server:

| Command | Action |
| :--- | :--- |
| `pm2 status` | View running backend and n8n processes |
| `pm2 logs` | View real-time console logs for debugging |
| `pm2 restart all` | Restart both n8n and the CRM backend |
| `pm2 stop all` | Stop both services |
| `pm2 restart unicomm-backend` | Restart only the CRM backend (applies changes in `.env`) |
| `node db/init.js` | Reset/Initialize the database tables (Run inside `backend/` folder) |

---

## 🔍 Troubleshooting

### 1. Microsoft Outlook Login Fails / Redirect Error
* The Microsoft Graph API requires HTTPS. Make sure your browser URL starts with **`https://`** and not `http://`.
* Check `backend/.env` and ensure `APP_PUBLIC_URL` matches the address in your browser address bar exactly.

### 2. Matrix PBX call logs are not showing up
* Open the **Matrix Jeeves Portal** (`https://192.168.0.81:1026`) and verify that the **Destination IP Address** under `SMDR Settings` is set to the Tower Server's IP: `192.168.0.200` and Port: `5001`.
* Ensure that the PBX SMDR port is allowed through the firewall. If needed, re-run the firewall command:
  ```powershell
  netsh advfirewall firewall add rule name="Matrix PBX SMDR 5001" dir=in action=allow protocol=TCP localport=5001
  ```

### 3. Database Connection Issues
* Verify the PostgreSQL service is active:
  ```powershell
  Get-Service -Name postgresql*
  ```
* If it is stopped, start it:
  ```powershell
  Start-Service -Name postgresql*
  ```
