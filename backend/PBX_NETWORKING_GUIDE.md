# Matrix PBX Networking Guide (SMDR/CTI)

This guide explains how to switch the Matrix PBX data stream between your **Laptop (Development)** and the **Tower Server (Production)**.

## 1. Access the Matrix Jeeves Portal
- **URL**: `https://192.168.0.81:1026/IndexNeSe.html`
- **Login**: (Your Matrix Admin Credentials)

## 2. Navigate to SMDR Settings
Go to: `Advanced Settings` ⮕ `SMDR` ⮕ `SMDR Online`

## 3. Update Destination IP Addresses
You must update the **Destination IP Address** for all three categories to match the machine where you are currently running the backend:

| Machine | IP Address | Usage |
| :--- | :--- | :--- |
| **Laptop** | `192.168.0.168` | Use this during development/debugging |
| **Tower Server** | `192.168.0.205` | Use this for live production deployment |

### Fields to Update:
1. **Destination Port for SMDR - Outgoing Call Online**
2. **Destination Port for SMDR - Incoming Call Online**
3. **Destination Port for SMDR - Internal Call Online**

> [!IMPORTANT]
> Ensure the **Port** is set to `5001` (or `05001`) in all fields.
> Click **Submit** at the bottom of the page to apply changes.

---

## 4. Backend Configuration (.env)
Ensure your `.env` file matches the port used above:
```env
SMDR_PORT=5001
CTI_PORT=5001
PBX_HOST=192.168.0.81
```

## 5. Troubleshooting Connectivity

### Check Terminal Logs
If the connection is successful, your backend terminal will show:
`[SMDR] ── INBOUND CONNECTION ─────────────────────────────`

### Firewall Rule (Windows)
If the backend is running but not receiving data, you may need to allow Port 5001 in the Windows Firewall. Run this in **PowerShell (Admin)**:
```powershell
netsh advfirewall firewall add rule name="PBX-SMDR" dir=in action=allow protocol=TCP localport=5001
```

### Network Isolation
Ensure both the Matrix PBX (`192.168.0.81`) and your Target Machine (`.168` or `.205`) can "Ping" each other.
