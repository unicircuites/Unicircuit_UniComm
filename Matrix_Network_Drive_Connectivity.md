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