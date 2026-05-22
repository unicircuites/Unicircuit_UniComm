# Port Mismatch Explanation

## The Problem (Visual)

### Before Fix ❌
```
┌─────────────────────────────────────────────────────────────┐
│                    MATRIX SARVAM UCS PBX                    │
│                    (192.168.0.81)                           │
│                                                             │
│  SMDR Posting Configuration:                               │
│  ├─ Destination IP: 192.168.0.169 ✓                        │
│  ├─ Port: 05001 (5001) ✓                                   │
│  └─ Status: Enabled ✓                                      │
│                                                             │
│  Sending data to: 192.168.0.169:5001                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    (Data being sent)
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              TOWER SERVER (192.168.0.169)                   │
│                                                             │
│  Node.js Server Configuration (.env):                      │
│  ├─ SMDR_PORT=5000 ❌ (WRONG!)                             │
│  └─ Listening on: 0.0.0.0:5000                             │
│                                                             │
│  Result: Data arrives at 5001, server listening on 5000    │
│  ⚠️  DATA NEVER REACHES SERVER!                            │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    (No connection)
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    DASHBOARD (Browser)                      │
│                                                             │
│  PBX Status: 🟡 YELLOW (Listening, no connection)          │
│  ⚠️  Expected: 🟢 GREEN (Connected)                        │
└─────────────────────────────────────────────────────────────┘
```

### After Fix ✓
```
┌─────────────────────────────────────────────────────────────┐
│                    MATRIX SARVAM UCS PBX                    │
│                    (192.168.0.81)                           │
│                                                             │
│  SMDR Posting Configuration:                               │
│  ├─ Destination IP: 192.168.0.169 ✓                        │
│  ├─ Port: 05001 (5001) ✓                                   │
│  └─ Status: Enabled ✓                                      │
│                                                             │
│  Sending data to: 192.168.0.169:5001                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    (Data being sent)
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              TOWER SERVER (192.168.0.169)                   │
│                                                             │
│  Node.js Server Configuration (.env):                      │
│  ├─ SMDR_PORT=5001 ✓ (CORRECT!)                            │
│  └─ Listening on: 0.0.0.0:5001                             │
│                                                             │
│  Result: Data arrives at 5001, server listening on 5001    │
│  ✓ DATA RECEIVED SUCCESSFULLY!                             │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    (Connection established)
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    DASHBOARD (Browser)                      │
│                                                             │
│  PBX Status: 🟢 GREEN (Connected, receiving data)          │
│  ✓ Real-time call logging active                           │
└─────────────────────────────────────────────────────────────┘
```

---

## Port Comparison

| Component | Port | Status |
|-----------|------|--------|
| PBX SMDR Posting | 5001 | ✓ Configured |
| PBX SMDR Online | 5001 | ✓ Configured |
| Server (before) | 5000 | ❌ Wrong |
| Server (after) | 5001 | ✓ Correct |
| Firewall (before) | 5000 | ❌ Wrong |
| Firewall (after) | 5001 | ✓ Correct |

---

## Why This Happened

### Original Assumption
The documentation was written for **ETERNITY NE**, which uses:
- SMDR port: 5000 (default)
- CTI port: 5001

### Your System
You're using **SARVAM UCS**, which uses:
- SMDR port: 5001 (default)
- CTI port: 5001

The PBX configuration was correct, but the server configuration was wrong!

---

## The Fix Applied

### File: `.env`
```diff
- SMDR_PORT=5000
+ SMDR_PORT=5001
```

### File: Firewall Rule
```diff
- Local Port: 5000
+ Local Port: 5001
```

---

## Data Flow After Fix

```
1. Call happens on PBX
   ↓
2. SMDR service records call
   ↓
3. PBX sends to 192.168.0.169:5001
   ↓
4. Server listening on 0.0.0.0:5001 receives it ✓
   ↓
5. Server parses call record
   ↓
6. Server saves to database
   ↓
7. Server emits Socket.IO event
   ↓
8. Dashboard updates in real-time ✓
```

---

## Verification Commands

### Check Server Listening Port
```powershell
netstat -ano | findstr :5001
```

Expected output:
```
TCP    0.0.0.0:5001           0.0.0.0:0              LISTENING       [PID]
```

### Check Firewall Rule
```powershell
netsh advfirewall firewall show rule name="PBX-SMDR"
```

Expected output:
```
Rule Name:                            PBX-SMDR
Enabled:                              Yes
Direction:                            In
Protocol:                             TCP
LocalPort:                            5001
Action:                               Allow
```

### Check PBX Configuration
Open: https://192.168.0.81:1026/IndexNeSe.html
Navigate to: Reports → SMDR → SMDR Posting

Expected:
```
Destination IP: 192.168.0.169
Port: 05001
Process: Start
```

---

## Summary

**Problem**: Port mismatch (5000 vs 5001)
**Root Cause**: Wrong SMDR_PORT in .env for SARVAM UCS
**Solution**: Change SMDR_PORT to 5001, update firewall, restart server
**Result**: Connection works, dashboard shows 🟢 green

