# Visual Guide: PBX Connection Flow

## Current State (Before Fix)

```
┌─────────────────────────────────────────────────────────────────┐
│                    MATRIX PBX (192.168.0.81)                    │
│                                                                 │
│  SMDR Service (Configured for SMDR Online)                     │
│  ├─ Status: Running                                            │
│  ├─ Output Format: SMDR Online (configured)                    │
│  └─ Actual Format: SMDR Report (not restarted yet)             │
│                                                                 │
│  Sending: CRLF (0x0d0a) — Report format                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓ TCP Port 5000
                    (Data being sent)
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│              TOWER SERVER (192.168.0.169)                       │
│                                                                 │
│  Node.js Server (port 5000)                                    │
│  ├─ Status: ✓ Listening                                        │
│  ├─ Receiving: ✓ Data from PBX                                 │
│  ├─ Parsing: ✓ Call records saved to DB                        │
│  └─ Handshake: ✗ No ENQ (0x00) received                        │
│                                                                 │
│  Emitting: pbx:connected (raw-tcp protocol)                    │
└─────────────────────────────────────────────────────────────────┘
                            ↓ Socket.IO
                    (Real-time events)
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DASHBOARD (Browser)                          │
│                                                                 │
│  PBX Status Indicator: 🟡 YELLOW (Listening)                   │
│  ├─ Status Text: "Passive Standby · Waiting for PBX Connection"│
│  ├─ Live Badge: Hidden                                         │
│  └─ Call Log: Empty (no real-time updates)                     │
│                                                                 │
│  ⚠️  Expected: 🟢 GREEN (Connected)                            │
└─────────────────────────────────────────────────────────────────┘
```

## After Fix (Expected State)

```
┌─────────────────────────────────────────────────────────────────┐
│                    MATRIX PBX (192.168.0.81)                    │
│                                                                 │
│  SMDR Service (Restarted)                                      │
│  ├─ Status: Running                                            │
│  ├─ Output Format: SMDR Online ✓                               │
│  └─ Actual Format: SMDR Online ✓                               │
│                                                                 │
│  Sending: ENQ (0x00) — Handshake                               │
└─────────────────────────────────────────────────────────────────┘
                            ↓ TCP Port 5000
                    (Handshake + Data)
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│              TOWER SERVER (192.168.0.169)                       │
│                                                                 │
│  Node.js Server (port 5000)                                    │
│  ├─ Status: ✓ Listening                                        │
│  ├─ Receiving: ✓ ENQ (0x00) handshake                          │
│  ├─ Responding: ✓ ACK (0x06)                                   │
│  ├─ Parsing: ✓ Real-time call records                          │
│  └─ Handshake: ✓ OG-Handshaking protocol active                │
│                                                                 │
│  Emitting: pbx:connected (OG-Handshaking protocol)             │
└─────────────────────────────────────────────────────────────────┘
                            ↓ Socket.IO
                    (Real-time events)
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DASHBOARD (Browser)                          │
│                                                                 │
│  PBX Status Indicator: 🟢 GREEN (Connected)                    │
│  ├─ Status Text: "Live Connected · Receiving Realtime SMDR"    │
│  ├─ Live Badge: Visible ✓                                      │
│  └─ Call Log: Real-time updates ✓                              │
│                                                                 │
│  ✓ Connection working correctly                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Handshake Protocol Sequence

### Current (Not Working)
```
Time    PBX                         Server              Dashboard
────────────────────────────────────────────────────────────────
T0      [Connect to 192.168.0.169:5000]
        ─────────────────────────→
                                    [Accept connection]
                                    [Wait for ENQ]

T1      [Send CRLF (0x0d0a)]
        ─────────────────────────→
                                    [Receive CRLF]
                                    [No ENQ detected]
                                    [Emit pbx:connected]
                                    ─────────────────→ 🟡 Yellow

T2      [Send call records]
        ─────────────────────────→
                                    [Parse & save]
                                    [Emit pbx:call]
                                    ─────────────────→ [No update]
```

### After Fix (Working)
```
Time    PBX                         Server              Dashboard
────────────────────────────────────────────────────────────────
T0      [Connect to 192.168.0.169:5000]
        ─────────────────────────→
                                    [Accept connection]
                                    [Wait for ENQ]

T1      [Send ENQ (0x00)]
        ─────────────────────────→
                                    [Receive ENQ]
                                    [Send ACK (0x06)]
        ←─────────────────────────
        [Receive ACK]
        [Handshake complete]

T2      [Send call records]
        ─────────────────────────→
                                    [Parse & save]
                                    [Emit pbx:connected]
                                    ─────────────────→ 🟢 Green

T3      [Send more records]
        ─────────────────────────→
                                    [Parse & save]
                                    [Emit pbx:call]
                                    ─────────────────→ [Real-time]
```

---

## Dashboard State Transitions

### Current (Stuck on Yellow)
```
┌──────────────────┐
│  🟡 LISTENING    │
│  (Waiting for    │
│   PBX to connect)│
└──────────────────┘
        ↓
   [PBX connects]
        ↓
┌──────────────────┐
│  🟡 LISTENING    │  ← STUCK HERE
│  (PBX connected  │
│   but no ENQ)    │
└──────────────────┘
```

### After Fix (Transitions to Green)
```
┌──────────────────┐
│  🟡 LISTENING    │
│  (Waiting for    │
│   PBX to connect)│
└──────────────────┘
        ↓
   [PBX connects]
        ↓
┌──────────────────┐
│  [ENQ received]  │
│  [ACK sent]      │
└──────────────────┘
        ↓
┌──────────────────┐
│  🟢 CONNECTED    │  ← SUCCESS
│  (Live SMDR data)│
└──────────────────┘
```

---

## Data Flow Diagram

### Call Record Journey

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. CALL HAPPENS ON PBX                                          │
│    User dials: 919545073545                                     │
│    Extension: 202                                               │
│    Duration: 2 minutes 18 seconds                               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. SMDR SERVICE RECORDS CALL                                    │
│    Formats as: 001 919545073545 M001 202 22-05-26 13:55:59 138 │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. PBX SENDS TO SERVER                                          │
│    Protocol: SMDR Online (after restart)                        │
│    Handshake: ENQ (0x00) → ACK (0x06)                           │
│    Data: [STX]record[ETX]                                       │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. SERVER RECEIVES & PARSES                                     │
│    Strips STX/ETX markers                                       │
│    Parses fixed-width fields                                    │
│    Validates date/time                                          │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. SERVER SAVES TO DATABASE                                     │
│    INSERT INTO call_logs (...)                                  │
│    Deduplicates by raw_line hash                                │
│    Updates CRM contact call count                               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. SERVER EMITS SOCKET.IO EVENT                                 │
│    Event: pbx:call                                              │
│    Data: { caller, destination, duration, ... }                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. DASHBOARD RECEIVES & DISPLAYS                                │
│    Updates call log in real-time                                │
│    Shows caller name from CRM                                   │
│    Increments contact call count                                │
│    Plays notification sound                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Network Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        OFFICE NETWORK                           │
│                      (192.168.0.0/24)                           │
│                                                                 │
│  ┌──────────────────────┐         ┌──────────────────────┐     │
│  │  MATRIX PBX          │         │  TOWER SERVER        │     │
│  │  192.168.0.81        │         │  192.168.0.169       │     │
│  │                      │         │                      │     │
│  │  SMDR Service        │         │  Node.js Server      │     │
│  │  Port: 5000 (out)    │         │  Port: 5000 (in)     │     │
│  │  Port: 5001 (CTI)    │         │  Port: 5001 (CTI)    │     │
│  └──────────────────────┘         │  Port: 8088 (HTTP)   │     │
│           │                       │                      │     │
│           │ TCP 5000              │  PostgreSQL          │     │
│           │ (SMDR Online)         │  Port: 5432          │     │
│           ├──────────────────────→│                      │     │
│           │                       │  Socket.IO           │     │
│           │                       │  (WebSocket)         │     │
│           │                       └──────────────────────┘     │
│           │                                │                   │
│           │                                │ HTTP/WebSocket    │
│           │                                │                   │
│           │                       ┌────────▼──────────┐        │
│           │                       │  BROWSER          │        │
│           │                       │  Dashboard        │        │
│           │                       │  (Any device)     │        │
│           │                       └───────────────────┘        │
│           │                                                    │
│  ┌────────▼──────────────────────────────────────────────┐    │
│  │  FIREWALL RULE: PBX-SMDR                             │    │
│  │  ├─ Direction: Inbound                               │    │
│  │  ├─ Protocol: TCP                                    │    │
│  │  ├─ Local Port: 5000                                 │    │
│  │  ├─ Remote IP: 192.168.0.81 (PBX)                    │    │
│  │  └─ Action: Allow                                    │    │
│  └────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting Decision Tree (Visual)

```
                    Is dashboard 🟢 green?
                            │
                ┌───────────┴───────────┐
                │                       │
               YES                      NO
                │                       │
                ✓                       ↓
            Working!          Is server listening on 5000?
                                       │
                            ┌──────────┴──────────┐
                            │                     │
                           NO                    YES
                            │                     │
                            ↓                     ↓
                    Start server         Can PBX reach server?
                    node server.js               │
                                    ┌───────────┴───────────┐
                                    │                       │
                                   NO                      YES
                                    │                       │
                                    ↓                       ↓
                            Check firewall         Is PBX sending ENQ?
                            Check network                  │
                                                ┌──────────┴──────────┐
                                                │                     │
                                               YES                    NO
                                                │                     │
                                                ✓                     ↓
                                            Working!        Restart SMDR service
                                                            on PBX
                                                            (System → Services)
                                                                    │
                                                                    ↓
                                                            Check again
                                                            (should be YES now)
```

---

## Summary

**Before Fix**: 🟡 Yellow (listening, no handshake)
**After Fix**: 🟢 Green (connected, OG-Handshaking protocol active)

**Action**: Restart SMDR service on PBX (System → Services → SMDR)

