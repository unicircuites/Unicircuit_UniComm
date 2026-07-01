# 🚀 UniComm Pro — Tower Server Quick Start & Setup Guide

This guide describes how to deploy the UniComm Pro CRM service on your freshly formatted **Tower Server (IP: 192.168.0.55)** from scratch.

> [!NOTE]
> n8n is a developer-machine-only workflow editor for this project. It runs locally at `http://localhost:5678` when you run `npm start` on your dev machine. It is not installed or started on the Tower server.

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

Run this in PowerShell to see if PM2 is running the CRM backend:

```powershell
pm2 status
```

*Expected Output:*

* `unicomm-backend` — **online**

### 2. Verify Client Browser Access

Open your web browser (on the server or any PC on the same network) and go to:

* **UniComm CRM Portal**: `https://192.168.0.55:8088`

The n8n automation console is only available on a dev machine at `http://localhost:5678` after running `npm start` locally.

> [!NOTE]
> Since we use a self-signed SSL certificate for network security, your browser will show an **"Unsafe Connection / Certificate Invalid"** warning the first time you load the page. Click **Advanced** ⮕ **Proceed to 192.168.0.55 (unsafe)** to open the dashboard. This is normal and expected for local servers.

---

## ⚙️ Operational Commands (Cheatsheet)

Run these commands inside `C:\setup0\Unicircuit_UniComm` to manage the server:

| Command                       | Action                                                              |
| :---------------------------- | :------------------------------------------------------------------ |
| `pm2 status`                  | View the running backend process                                    |
| `pm2 logs`                    | View real-time console logs for debugging                           |
| `pm2 restart unicomm-backend` | Restart the CRM backend (applies changes in `.env`)                 |
| `pm2 stop unicomm-backend`    | Stop the CRM backend                                                |
| `node db/init.js`             | Reset/initialize the database tables (run inside `backend/` folder) |

---

## 🔍 Troubleshooting

### 1. Microsoft Outlook Login Fails / Redirect Error

* The Microsoft Graph API requires HTTPS. Make sure your browser URL starts with **`https://`** and not `http://`.
* Check `backend/.env` and ensure `APP_PUBLIC_URL` matches the address in your browser address bar exactly.

### 2. Matrix PBX call logs are not showing up

* Open the **Matrix Jeeves Portal** (`https://192.168.0.81:1026`) and verify that the **Destination IP Address** under `SMDR Settings` is set to the Tower Server's IP: `192.168.0.55` and Port: `5001`.
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
