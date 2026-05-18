============================================================
 PART 1 - WINDOWS SETUP & CMD COMMANDS
============================================================


STEP 1 - CHECK PC IP ADDRESS
------------------------------------------------------------

Open CMD and run:

ipconfig


Expected Active IP:
192.168.0.168


------------------------------------------------------------
STEP 2 - CHECK CURRENT WINDOWS USER
------------------------------------------------------------

Run:

whoami


------------------------------------------------------------
STEP 3 - CREATE SHARED FOLDER
------------------------------------------------------------

Run:

mkdir C:\MatrixVMS


OR manually create folder:

C:\MatrixVMS


------------------------------------------------------------
STEP 4 - CREATE SMB USER FOR MATRIX
------------------------------------------------------------

Open CMD as Administrator.

Run:

net user matrix 12345 /add


Optional Admin Access:

net localgroup administrators matrix /add


------------------------------------------------------------
STEP 5 - SHARE FOLDER
------------------------------------------------------------

Right Click:
C:\MatrixVMS

→ Properties
→ Sharing
→ Advanced Sharing

Enable:
[✓] Share this folder

Share Name:
MatrixVMS


------------------------------------------------------------
STEP 6 - SHARE PERMISSIONS
------------------------------------------------------------

Permissions
→ Add Everyone

Allow:
[✓] Full Control
[✓] Change
[✓] Read


------------------------------------------------------------
STEP 7 - SECURITY PERMISSIONS
------------------------------------------------------------

Properties
→ Security
→ Edit
→ Add

Add:
Everyone

Allow:
[✓] Full Control


------------------------------------------------------------
STEP 8 - ENABLE WINDOWS NETWORK SHARING
------------------------------------------------------------

Open:

Control Panel
→ Network and Sharing Center
→ Advanced Sharing Settings


Enable:
[✓] Network Discovery
[✓] File and Printer Sharing

Disable:
[ ] Password Protected Sharing


------------------------------------------------------------
STEP 9 - VERIFY SHARED FOLDER ACCESS
------------------------------------------------------------

Press:
Win + R

Open:

\\192.168.0.168\MatrixVMS


Expected Result:
Folder opens successfully.


------------------------------------------------------------
STEP 10 - VERIFY NETWORK CONNECTIVITY
------------------------------------------------------------

Run:

ping 192.168.0.168


Expected Result:
Reply received successfully.


============================================================
 END OF PART 1
============================================================

============================================================
 PART 2 - MATRIX UCS CONFIGURATION
============================================================


PBX DETAILS
------------------------------------------------------------

Matrix PBX IP:
192.168.0.81

Web URL:
https://192.168.0.81:1026/


============================================================
 STEP 1 - CONFIGURE NETWORK DRIVE
============================================================

Login to Matrix Web Panel.

Go To:

Maintenance
→ Network Drive


------------------------------------------------------------
CONFIGURE VALUES
------------------------------------------------------------

Network Drive:
Enabled

IP Address:
192.168.0.168

Authentication Required:
Checked

Username:
matrix

Password:
12345

Shared Folder Name:
MatrixVMS


------------------------------------------------------------
VERIFY CONNECTION
------------------------------------------------------------

Click:
TEST

Expected Result:
Connected Successfully


Click:
SUBMIT


============================================================
 STEP 2 - CONFIGURE VOICEMAIL BACKUP
============================================================

Go To:

Voice Mail
→ Voicemail Backup


Backup Type:
Network Drive


Backup Destination:
\\192.168.0.168\MatrixVMS


------------------------------------------------------------
RUN MANUAL BACKUP
------------------------------------------------------------

Click:
Manual Backup


Expected Result:
Backup files created inside:

C:\MatrixVMS


============================================================
 FINAL NETWORK PATH
============================================================

\\192.168.0.168\MatrixVMS


============================================================
 FUTURE APPLICATION ACCESS
============================================================

Future application running on:

192.168.0.205

can access recordings using:

\\192.168.0.168\MatrixVMS


============================================================
 ISSUES FACED & RESOLUTIONS
============================================================


ISSUE:
------------------------------------------------------------
Host Unreachable


CAUSE:
Inactive old host IP.


RESOLUTION:
Used active PC IP:
192.168.0.168


------------------------------------------------------------
ISSUE:
Authentication Failed


CAUSE:
Invalid SMB credentials.


RESOLUTION:
Created dedicated SMB user:

Username:
matrix

Password:
12345


------------------------------------------------------------
ISSUE:
Backup Connection Failed


CAUSE:
Folder permissions issue.


RESOLUTION:
Granted Everyone → Full Control.


============================================================
 FINAL STATUS
============================================================

[✓] SMB Share Working
[✓] Matrix Connectivity Successful
[✓] Shared Folder Accessible
[✓] Network Drive Connected
[✓] Backup Path Configured


============================================================
 END OF PART 2
============================================================

# Matrix SARVAM UCS Network Drive Connection Setup Summary

## Goal

Connect Matrix SARVAM UCS PBX/VMS system to Windows shared folder for call recordings/network storage.

---

# Environment

## Devices

* Matrix SARVAM UCS PBX: `192.168.0.81`
* Windows Tower Server (shared storage): `192.168.0.205`
* Local Testing Machine: `192.168.0.168`

## Shared Folder

* Folder Path: `C:\MatrixVMS`
* Share Name: `MatrixVMS`

## User Created

* Username: `matrix`
* Password: `12345`

---

# Steps Performed

## 1. Created Local Windows User

Command used:

```cmd
net user matrix 12345 /add
```

Purpose:

* Dedicated non-admin SMB login user for Matrix PBX.
* Avoided giving Administrator access for security reasons.

---

## 2. Shared Folder Setup

Folder shared:

```text
C:\MatrixVMS
```

Share Name:

```text
MatrixVMS
```

Share Path:

```text
\\192.168.0.205\MatrixVMS
```

---

## 3. NTFS Permissions Added

User `matrix` was granted Full Control on:

```text
C:\MatrixVMS
```

Verified using:

```cmd
icacls C:\MatrixVMS
```

Result included:

```text
DESKTOP-6J37NPS\matrix:(OI)(CI)(F)
```

---

## 4. SMB Share Verification

Verified active SMB share using:

```cmd
net share
```

Result:

```text
MatrixVMS    C:\MatrixVMS
```

---

## 5. Enabled Network Discovery & File Sharing

Commands executed:

```cmd
netsh advfirewall firewall set rule group="Network Discovery" new enable=Yes
```

```cmd
netsh advfirewall firewall set rule group="File and Printer Sharing" new enable=Yes
```

---

## 6. Set Network Profile to Private

Command used:

```cmd
powershell -Command "Set-NetConnectionProfile -NetworkCategory Private"
```

Purpose:

* Allow SMB sharing on local LAN.

---

## 7. Verified SMB Port 445

Command:

```cmd
netstat -an | find ":445"
```

Result:

```text
LISTENING
```

Meaning:

* SMB service listening properly.

---

## 8. Verified SMB Service Running

Command:

```cmd
sc query lanmanserver
```

Result:

```text
STATE : RUNNING
```

---

## 9. Enabled SMB1 Support

Matrix firmware required old SMB compatibility.

Verified using:

```cmd
dism /online /Get-Features /format:table | find "SMB1"
```

Result:

```text
SMB1Protocol-Client : Enabled
SMB1Protocol-Server : Enabled
```

---

## 10. Enabled Legacy Authentication Compatibility

Registry change applied:

```cmd
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Lsa" /v LmCompatibilityLevel /t REG_DWORD /d 1 /f
```

Purpose:

* Allow old NTLM/LM authentication used by legacy Matrix firmware.

---

## 11. Enabled LocalAccountTokenFilterPolicy

Registry command:

```cmd
reg add "HKLM\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters" /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f
```

Purpose:

* Allow remote SMB authentication using local Windows accounts.

---

## 12. Restarted SMB Server Service

Commands used:

```cmd
net stop server /y
```

```cmd
net start server
```

---

# Connectivity Testing Performed

## Local Machine SMB Test

Command:

```cmd
net use Z: \\192.168.0.205\MatrixVMS /user:192.168.0.205\matrix 12345
```

Result:

```text
The command completed successfully.
```

Directory listing test:

```cmd
dir Z:\
```

Result successful.

Meaning:

* Windows-to-Windows SMB fully functional.

---

# Final Working Matrix SARVAM UCS Settings

## IP Address

```text
192.168.0.205
```

## Authentication Required

```text
Enabled
```

## User Name

```text
matrix
```

## Password

```text
12345
```

## Shared Folder Name

```text
MatrixVMS
```

---

# Root Cause Identified

The issue was NOT:

* firewall
* permissions
* SMB share
* connectivity
* VMware networking

Actual issue:

* Legacy Matrix SARVAM UCS firmware required older SMB/NTLM authentication compatibility.

Fixes that solved it:

* SMB1 enabled
* LM/NTLM compatibility enabled
* Local account SMB auth allowed
* Proper share + NTFS permissions configured

---

# Final Result

Matrix SARVAM UCS successfully connected to:

```text
\\192.168.0.205\MatrixVMS
```

and network drive/call recording storage started working successfully.
