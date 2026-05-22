# SMDR Protocol Implementation Details

## Overview

The Matrix Eternity PBX supports multiple SMDR (Station Message Detail Record) protocols for call logging:

1. **SMDR Online** (Real-Time) — What we want ✓
2. **SMDR Report** (Historical) — What we're currently getting
3. **SMDR Posting** (Legacy) — Older format

---

## SMDR Online Protocol (OG Handshaking)

### Connection Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. PBX connects to server on port 5000                      │
│    (TCP connection established)                             │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. PBX sends ENQ (0x00) — "Are you ready?"                  │
│    Hex: 00                                                  │
│    Timeout: 20 seconds (PBX waits for ACK)                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Server responds with ACK (0x06) — "Yes, I'm ready"       │
│    Hex: 06                                                  │
│    Must respond within 3 seconds                            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. PBX sends call records wrapped in STX/ETX               │
│    STX (0x02) = Start of Text                              │
│    ETX (0x03) = End of Text                                │
│    Format: [STX]call_record[ETX]                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. Server parses and saves to database                      │
│    Emits Socket.IO event for real-time dashboard           │
└─────────────────────────────────────────────────────────────┘
```

### Call Record Format (Fixed-Width)

```
Position  Length  Field                Example
────────────────────────────────────────────────────────────
1-5       5       Record ID            00001
6-21      16      Calling Number       919545073545
23-27     5       Trunk                M001
29-34     6       Connected Number     202
36-43     8       Date (DD-MM-YY)      22-05-26
45-52     8       Time (HH:MM:SS)      13:55:59
54-58     5       Duration (seconds)   138
60-60     1       Call Type            I (In) / O (Out)
62-64     3       Remarks              1
```

### Example Call Record

```
001 919545073545 M001 202 22-05-26 13:55:59 138 1 1.10 I
```

Parsed as:
- **ID**: 001
- **Caller**: 919545073545 (incoming)
- **Trunk**: M001
- **Extension**: 202
- **Date**: 22-05-26 (May 26, 2022)
- **Time**: 13:55:59
- **Duration**: 138 seconds (2:18)
- **Type**: I (Incoming)

---

## SMDR Report Format (What We're Currently Getting)

### Structure

```
DAILY OUTGOING CALLS REPORT
Date: 22-05-26
Time: 13:55:59

Call Details:
─────────────────────────────────────────────────────────────
Sl.No  From      To        Duration  Date       Time
─────────────────────────────────────────────────────────────
1      M001      919545... 00:02:18  22-05-26   13:55:59
2      M002      919545... 00:01:45  22-05-26   14:02:30
...

Total Calls: 42
Total Duration: 1:23:45
```

### Characteristics
- **Handshake**: None (raw TCP)
- **Data Format**: Human-readable text with headers
- **Timing**: On-demand or scheduled (not real-time)
- **Use Case**: Historical reporting, end-of-day summaries

---

## Server Implementation

### File: `backend/services/matrixSmdr.js`

#### Handshake Handler
```javascript
socket.on('data', (data) => {
  if (!handshakeComplete) {
    // Check for ENQ (0x00)
    if (data.length > 0 && data[0] === 0x00) {
      // Send ACK (0x06)
      socket.write(Buffer.from([0x06]));
      handshakeComplete = true;
      emit('pbx:connected', { protocol: 'OG-Handshaking' });
    } else {
      // No handshake — treat as raw data
      handshakeComplete = true;
      emit('pbx:connected', { protocol: 'raw-tcp' });
    }
  }
  // Process data...
});
```

#### Data Parser
```javascript
function parseSMDR(line) {
  // Try space-delimited format first
  const parts = line.split(/\s+/);
  
  if (parts.length >= 6 && isDate(parts[1]) && isTime(parts[2])) {
    // Space-delimited format
    return {
      call_date: parseDate(parts[1]),
      call_time: parts[2],
      duration: formatDuration(parts[3]),
      call_type: parts[4],
      caller: parts[5],
      destination: parts[6],
      // ...
    };
  }
  
  // Try fixed-width format
  if (line.length >= 70) {
    const get = (start, len) => line.substring(start - 1, start - 1 + len).trim();
    return {
      call_date: parseDate(get(36, 8)),
      call_time: get(47, 8),
      duration: formatDuration(get(64, 5)),
      // ...
    };
  }
  
  return null;
}
```

#### Database Schema
```sql
CREATE TABLE call_logs (
  id SERIAL PRIMARY KEY,
  call_date DATE,
  call_time TIME,
  duration VARCHAR(20),
  call_type VARCHAR(20),
  caller VARCHAR(100),
  extension VARCHAR(20),
  destination VARCHAR(100),
  trunk VARCHAR(50),
  recording_file TEXT,
  ai_summary TEXT,
  raw_line TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Socket.IO Events

### Server → Client

#### `pbx:listening`
Emitted when server starts listening (no PBX connected yet).
```javascript
{
  mode: 'server',
  port: 5000,
  connectedAt: 1779439493516
}
```

#### `pbx:connected`
Emitted when PBX successfully connects and handshakes.
```javascript
{
  ip: '192.168.0.81',
  port: 60957,
  connectedAt: 1779439570902,
  mode: 'server',
  isPBX: true,
  protocol: 'OG-Handshaking' // or 'raw-tcp'
}
```

#### `pbx:disconnected`
Emitted when PBX disconnects.
```javascript
{
  disconnectedAt: 1779439600000,
  reason: 'Peer disconnected',
  peers: 0,
  fatal: false
}
```

#### `pbx:call`
Emitted when a new call record is saved.
```javascript
{
  id: 12345,
  call_date: '2026-05-22',
  call_time: '13:55:59',
  duration: '00:02:18',
  call_type: 'In',
  caller: '919545073545',
  extension: '202',
  destination: '202',
  trunk: 'M001',
  created_at: '2026-05-22T13:55:59.123Z'
}
```

### Client → Server

#### `pbx:reconnect`
Sent by dashboard to manually reconnect.
```javascript
socket.emit('pbx:reconnect');
```

---

## Troubleshooting Decision Tree

```
Is dashboard showing 🟢 green?
├─ YES → ✓ Connection working, skip to "Verify Call Logging"
└─ NO → Continue below

Is server listening on port 5000?
├─ NO → Start server: node server.js
└─ YES → Continue below

Can PBX reach server?
├─ NO → Check firewall, network, IP configuration
└─ YES → Continue below

Is PBX sending ENQ (0x00)?
├─ YES → ✓ OG-Handshaking protocol active
├─ NO → PBX sending SMDR Report format
│   └─ FIX: Restart SMDR service on PBX
└─ UNKNOWN → Check server logs for first data byte

After restart, is ENQ being sent?
├─ YES → ✓ Dashboard should show 🟢 green
└─ NO → Check PBX SMDR configuration
    └─ Verify: IP=192.168.0.169, Port=5000, Enabled=Yes
```

---

## Performance Metrics

### Expected Throughput
- **Call records per second**: 1-5 (typical office)
- **Database insert time**: 10-50ms per record
- **Socket.IO broadcast time**: 5-20ms
- **Dashboard update time**: 100-500ms (browser rendering)

### Latency
- **PBX to server**: <10ms (local network)
- **Server processing**: 20-100ms
- **Dashboard display**: 100-500ms
- **Total end-to-end**: 150-600ms

### Reliability
- **Connection timeout**: 20 seconds (PBX waits for ACK)
- **Handshake timeout**: 5 seconds (server waits for ENQ)
- **Auto-reconnect**: Every 30 seconds if disconnected
- **Duplicate detection**: Based on raw_line hash

---

## Configuration

### Environment Variables (.env)
```
PBX_HOST=192.168.0.81          # PBX hardware IP
SMDR_PORT=5000                 # SMDR listening port
CTI_PORT=5001                  # CTI control port
```

### PBX Configuration (Matrix Jeeves)
```
System → SMDR Settings
├─ SMDR Posting: Enabled
├─ IP Address: 192.168.0.169
├─ Port: 5000
├─ Process: Start
└─ Output Format: SMDR Online (not Report)

System → CTI Settings
├─ CTI Enabled: Yes
├─ Port: 5001
└─ Create CTI user for click-to-dial
```

---

## References

- Matrix Eternity NE System Manual (Chapter: CTI Integration)
- SMDR Protocol Specification (OG Handshaking)
- Call Record Format Documentation
- Network Configuration Guide

