# Matrix SMDR Connection Debugging Guide

## Overview

The `matrixSmdr.js` file now includes **comprehensive deep-level console.logs** at every step of the connection process. This guide explains what each debug output means and how to diagnose connection issues.

---

## Debug Output Sections

### 1. INITIALIZATION DEBUG (On Server Start)

```
[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗
[SMDR-DEBUG] ║ MATRIX SMDR SERVICE — INITIALIZATION DEBUG              ║
[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝
```

**What it checks:**
- Environment variables from `.env` file
- Configuration value parsing
- Port and IP validation
- Network configuration summary

**What to look for:**
- ✅ `PBX_HOST is valid: 192.168.0.81` — Correct PBX IP
- ❌ `PBX_HOST is set to Tower Server IP (192.168.0.205)` — WRONG! Fix in `.env`
- ❌ `SMDR_PORT is not a number!` — Port not properly configured
- ⚠️ `SMDR_PORT and CTI_PORT are the same` — Unusual but allowed

---

### 2. TCP SERVER STARTUP DEBUG

```
[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗
[SMDR-DEBUG] ║ TCP SERVER STARTUP — DETAILED TRACE                    ║
[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝
```

**What it checks:**
- Pre-startup validation
- Server creation
- Port binding

**What to look for:**
- ✅ `net.createServer() created successfully` — Server object created
- ✅ `Listening on 0.0.0.0:5001` — Server bound to port
- ❌ `Port 5001 is already in use!` — Another process using the port
- ❌ `Permission denied for port 5001` — Need elevated privileges

---

### 3. INBOUND CONNECTION RECEIVED DEBUG

```
[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗
[SMDR-DEBUG] ║ INBOUND CONNECTION RECEIVED — DETAILED TRACE            ║
[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝
```

**What it checks:**
- Socket object properties
- PBX identification
- Connection state management

**What to look for:**
- ✅ `Is PBX? = ✅ YES — matches PBX_HOST (192.168.0.81)` — Correct source
- ❌ `Is PBX? = ❌ NO — unexpected source` — Connection from wrong IP
  - Check PBX configuration (SMDR Posting Destination IP)
  - Check network routing
  - Verify PBX_HOST in `.env`

**Socket Properties:**
- `socket.readable = true` — Can receive data
- `socket.writable = true` — Can send data
- `socket.destroyed = false` — Socket is active

---

### 4. HANDSHAKE PROTOCOL DEBUG

```
[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗
[SMDR-DEBUG] ║ DATA RECEIVED — DETAILED ANALYSIS                      ║
[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝
```

**What it checks:**
- Raw data inspection
- Handshake phase analysis
- ENQ/ACK protocol

**What to look for:**

#### ✅ Successful Handshake:
```
[SMDR-DEBUG] First byte (hex) = 0x00
[SMDR-DEBUG] ✅ ENQ (0x00) DETECTED — Handshake initiated!
[SMDR-DEBUG] 📤 Sending ACK (0x06) response...
[SMDR-DEBUG] ✅ ACK sent successfully
[SMDR-DEBUG] Protocol: OG-Handshaking
```

#### ❌ Handshake Timeout:
```
[SMDR-DEBUG] ⏱️  HANDSHAKE TIMEOUT from 192.168.0.81:12345
[SMDR-DEBUG] No ENQ (0x00) received within 5 seconds
```

**Possible causes:**
1. PBX SMDR service not fully started
2. PBX sending SMDR Report (historical) instead of SMDR Online (real-time)
3. PBX configuration mismatch

**Fix:**
- Restart SMDR service on PBX (System → Services → SMDR)
- Verify SMDR Online is enabled (not just SMDR Report)
- Click the blue "Start" button in PBX web interface

#### ⚠️ Unexpected Data (No Handshaking):
```
[SMDR-DEBUG] ⚠️  UNEXPECTED DATA — Expected ENQ (0x00)
[SMDR-DEBUG] Received: "some data here"
[SMDR-DEBUG] Hex: 736f6d6520646174612068657265
[SMDR-DEBUG] Treating as raw-tcp protocol (no handshaking)
```

**Possible causes:**
1. PBX sending SMDR Report instead of SMDR Online
2. PBX SMDR service not fully initialized
3. PBX configuration mismatch

**Fix:**
- Ensure SMDR Online is enabled on PBX
- Restart SMDR service
- Check PBX configuration

---

### 5. DATA PROCESSING DEBUG

```
[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗
[SMDR-DEBUG] ║ BUFFER PROCESSING — SMDR RECORD PARSING                ║
[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝
```

**What it checks:**
- Buffer size and content
- Record extraction
- SMDR record parsing

**What to look for:**
- `Buffer size = 256 bytes` — Data received
- `Records found = 3` — Number of SMDR records in buffer
- `Record 1/3: ✅ Parsed successfully` — Record parsed correctly
- `Record 2/3: ❌ Failed to parse record` — Parsing error

---

### 6. SMDR RECORD PARSING DEBUG

```
[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗
[SMDR-DEBUG] ║ SMDR RECORD PARSING — DETAILED ANALYSIS                ║
[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝
```

**What it checks:**
- Input validation
- Format detection (space-delimited vs fixed-width)
- Field extraction
- Date/time normalization
- Duration conversion

**What to look for:**

#### ✅ Space-Delimited Format:
```
[SMDR-DEBUG] Space-delimited format detected
[SMDR-DEBUG] Part[1] is date? = true (22-05-2026)
[SMDR-DEBUG] Part[2] is time? = true (14:30:45)
[SMDR-DEBUG] ✅ Space-delimited format detected
```

#### ✅ Fixed-Width Format:
```
[SMDR-DEBUG] Line length = 85
[SMDR-DEBUG] ✅ Line length sufficient for fixed-width parsing
[SMDR-DEBUG] Layout type = incoming
```

#### ❌ Format Not Detected:
```
[SMDR-DEBUG] ❌ No valid format detected
```

**Possible causes:**
1. SMDR record format not recognized
2. Line too short
3. Date/time format incorrect

---

### 7. SOCKET CLOSED DEBUG

```
[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗
[SMDR-DEBUG] ║ SOCKET CLOSED — DETAILED TRACE                         ║
[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝
```

**What it checks:**
- Close event analysis
- Connection state update
- Disconnection reason

**What to look for:**
- `Had error? = false` — Clean disconnect
- `Had error? = true` — Error caused disconnect
- `connectedPeers (after) = 0` — No active connections
- `Reason = Peer disconnected` — PBX closed connection
- `Reason = Socket error` — Network error

---

### 8. SERVER ERROR DEBUG

```
[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗
[SMDR-DEBUG] ║ SERVER ERROR — DETAILED TRACE                          ║
[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝
```

**What it checks:**
- Server error details
- Error codes
- Recovery actions

**Common Error Codes:**
- `EADDRINUSE` — Port already in use
- `EACCES` — Permission denied (privileged port)
- `ECONNREFUSED` — Connection refused
- `ETIMEDOUT` — Connection timeout

---

## Troubleshooting Flowchart

### Problem: Server starts but no connection from PBX

1. **Check initialization logs:**
   ```
   [SMDR-DEBUG] PBX_HOST is valid: 192.168.0.81 ✅
   [SMDR-DEBUG] SMDR_PORT is valid: 5001 ✅
   ```

2. **Check server startup:**
   ```
   [SMDR-DEBUG] ✅ Listening on 0.0.0.0:5001
   ```

3. **Check for inbound connection:**
   - If no "INBOUND CONNECTION RECEIVED" message appears:
     - PBX is not sending data to this server
     - Check PBX SMDR Posting configuration
     - Verify Destination IP is correct (192.168.0.169)
     - Verify Port is correct (5001)
     - Click "Start" button on PBX

### Problem: Connection received but no handshake

1. **Check connection source:**
   ```
   [SMDR-DEBUG] Is PBX? = ✅ YES
   ```

2. **Check for ENQ:**
   ```
   [SMDR-DEBUG] ⏱️  HANDSHAKE TIMEOUT
   ```
   - PBX is not sending ENQ (0x00)
   - Restart SMDR service on PBX
   - Verify SMDR Online is enabled

### Problem: Handshake complete but no data

1. **Check for data events:**
   ```
   [SMDR-DEBUG] ║ DATA RECEIVED — DETAILED ANALYSIS
   ```

2. **Check buffer processing:**
   ```
   [SMDR-DEBUG] Records found = 0
   ```
   - No SMDR records in buffer
   - PBX may not be sending call data
   - Make a test call on PBX

### Problem: Data received but not parsed

1. **Check parsing logs:**
   ```
   [SMDR-DEBUG] ❌ Failed to parse record
   ```

2. **Check format detection:**
   ```
   [SMDR-DEBUG] ❌ No valid format detected
   ```
   - SMDR record format not recognized
   - May need to adjust parsing logic
   - Check raw line content in logs

---

## How to Enable Debug Logs

Debug logs are **always enabled** in the updated `matrixSmdr.js`. They will appear in:

1. **Server console output** (where you run `node server.js`)
2. **Log files** (if configured)
3. **Browser console** (via Socket.IO events)

---

## Key Debug Markers

| Marker | Meaning |
|--------|---------|
| `✅` | Success — everything working |
| `❌` | Error — something failed |
| `⚠️` | Warning — unusual but may work |
| `💓` | Heartbeat — service alive |
| `📋` | Step marker — process stage |
| `📥` | Data received |
| `📤` | Data sent |
| `🤝` | Handshake event |
| `⏱️` | Timeout event |

---

## Next Steps

1. **Start the server:**
   ```bash
   node backend/server.js
   ```

2. **Monitor the console output** for debug messages

3. **Make a test call** on the PBX

4. **Check the logs** for:
   - Connection received
   - Handshake complete
   - Data received
   - Records parsed

5. **If connection fails**, use the troubleshooting flowchart above

---

## Contact Support

If you see errors in the debug logs that you don't understand:

1. **Copy the entire debug output** from the console
2. **Include the error message** and error code
3. **Describe what you were doing** when the error occurred
4. **Provide PBX configuration** (SMDR Posting settings)

