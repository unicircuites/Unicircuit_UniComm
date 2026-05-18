/**
 * Matrix Eternity SMDR Service
 * Connects to Matrix PBX TCP SMDR port, parses call records, saves to DB
 * Matrix SMDR format (fixed-width):
 * Field positions based on Matrix Eternity NX/GE SMDR output
 *
 * Matrix Eternity CTI integration:
 *   SMDR port (default 5000) — PBX pushes raw call records TO this TCP server
 *   CTI  port (default 5001) — real-time call control (click-to-dial, pickup, transfer)
 *
 * PBX-side setup required:
 *   System → SMDR Settings  → Enable SMDR: YES, Output: TCP Server, Port: SMDR_PORT
 *   System → CTI  Settings  → Enable CTI:  YES, Port: CTI_PORT, create CTI user
 */
const net = require('net');
const pool = require('../db/pool');

// ── CONFIG (from .env) ────────────────────────────────────────────────────
const PBX_HOST = process.env.PBX_HOST || '192.168.0.81';
if (PBX_HOST === '192.168.0.205') {
  console.warn('[SMDR] ⚠️ WARNING: PBX_HOST is set to local server IP (192.168.0.205). Ensure this is the PBX IP (192.168.0.81).');
}
const SMDR_PORT = parseInt(process.env.SMDR_PORT || '5000');
const CTI_PORT = parseInt(process.env.CTI_PORT || '5001');

// ── STARTUP CONFIG DUMP ───────────────────────────────────────────────────
console.log('[SMDR] ══════════════════════════════════════════════════════');
console.log('[SMDR] Matrix Eternity CTI — configuration check');
console.log(`[SMDR]   PBX_HOST  : ${PBX_HOST}  (Matrix Eternity IP)`);
console.log(`[SMDR]   SMDR_PORT : ${SMDR_PORT}  (PBX → this server, raw call records)`);
console.log(`[SMDR]   CTI_PORT  : ${CTI_PORT}  (click-to-dial / call control)`);
console.log('[SMDR]   Source    : process.env (SMDR_PORT=' +
  (process.env.SMDR_PORT ? process.env.SMDR_PORT + ' ✅ set in .env' : 'NOT SET — using default 5000 ⚠️') + ')');
console.log('[SMDR]   Source    : process.env (CTI_PORT=' +
  (process.env.CTI_PORT ? process.env.CTI_PORT + ' ✅ set in .env' : 'NOT SET — using default 5001 ⚠️') + ')');
console.log('[SMDR] ══════════════════════════════════════════════════════');

let io = null;
let isConnected = false;
let buffer = '';

function setIO(socketIO) { io = socketIO; }

function emit(event, data) {
  if (io) {
    console.log(`[SMDR] 📡 Emitting Socket.IO event: "${event}"`, data ? JSON.stringify(data) : '(no data)');
    io.emit(event, data);
  } else {
    console.warn(`[SMDR] ⚠️ Cannot emit "${event}" - Socket.IO (io) is not initialized`);
  }
}

function formatDurationFromSeconds(seconds) {
  const sec = Math.max(0, parseInt(seconds, 10) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
}

function isMatrixDate(value) {
  return /^\d{1,2}-\d{2}-\d{2,4}$/.test(String(value || '').trim());
}

function isMatrixTime(value) {
  return /^\d{2}:\d{2}:\d{2}$/.test(String(value || '').trim());
}

function parseMatrixDate(rawDate) {
  const dp = String(rawDate || '').trim().split('-');
  if (dp.length !== 3) return null;
  const yr = dp[2].length === 2 ? '20' + dp[2] : dp[2];
  return `${yr}-${dp[1].padStart(2, '0')}-${dp[0].padStart(2, '0')}`;
}

function normaliseSmdrLineForDedupe(rawLine) {
  return String(rawLine || '').trim().replace(/^\d+\s+/, '');
}

function parseMatrixFixedLayout(rawLine) {
  const get = (start, len) => rawLine.substring(start - 1, (start - 1) + len).trim();
  const durationAfterTime = (rawTime) => {
    const afterTime = rawLine.slice(rawLine.indexOf(rawTime) + rawTime.length).trim();
    const numericFields = afterTime.match(/\b\d+(?:\.\d+)?\b/g) || [];
    if (!numericFields.length) return 0;
    return Math.round(parseFloat(numericFields[numericFields.length - 1]) || 0);
  };
  const incomingDate = get(36, 8);
  const incomingTime = get(47, 8);
  const outgoingDate = get(41, 8);
  const outgoingTime = get(50, 8);

  if (isMatrixDate(incomingDate) && isMatrixTime(incomingTime)) {
    return {
      layout: 'incoming',
      callingNum: get(6, 16),
      trunk: get(23, 5),
      connectedNum: get(29, 6),
      rawDate: incomingDate,
      rawTime: incomingTime,
      durationSeconds: parseInt(get(64, 5), 10) || durationAfterTime(incomingTime),
      remarks: get(70, 2),
    };
  }

  if (isMatrixDate(outgoingDate) && isMatrixTime(outgoingTime)) {
    return {
      layout: 'outgoing',
      callingNum: get(6, 6),
      trunk: get(17, 5),
      connectedNum: get(22, 18),
      rawDate: outgoingDate,
      rawTime: outgoingTime,
      durationSeconds: parseInt(get(59, 5), 10) || 0,
      remarks: get(78, 2),
    };
  }

  const dateTimeMatch = rawLine.match(/\b(\d{1,2}-\d{2}-\d{2,4})\s+(\d{2}:\d{2}:\d{2})\b/);
  const parts = rawLine.trim().split(/\s+/);
  if (dateTimeMatch && parts.length >= 6) {
    return {
      layout: 'space-delimited',
      callingNum: parts[1] || '',
      trunk: parts[2] || '',
      connectedNum: parts[3] || '',
      rawDate: dateTimeMatch[1],
      rawTime: dateTimeMatch[2],
      durationSeconds: durationAfterTime(dateTimeMatch[2]),
      remarks: parts[parts.length - 1] || '',
    };
  }

  return null;
}

// ── ENSURE TABLE ──────────────────────────────────────────────────────────
async function ensureTable(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS call_logs (
          id           SERIAL PRIMARY KEY,
          call_date    DATE,
          call_time    TIME,
          duration     VARCHAR(20),
          call_type    VARCHAR(20),
          caller       VARCHAR(100),
          extension    VARCHAR(20),
          destination  VARCHAR(100),
          trunk        VARCHAR(50),
          ai_summary   TEXT,
          raw_line     TEXT,
          created_at   TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Add columns if they don't exist (for existing tables)
      const cols = ['call_date DATE', 'call_time TIME', 'trunk VARCHAR(50)', 'raw_line TEXT'];
      for (const col of cols) {
        const name = col.split(' ')[0];
        await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ${name} ${col.split(' ').slice(1).join(' ')}`).catch(() => { });
      }
      return; // Success
    } catch (err) {
      console.warn(`[SMDR] Table ensure attempt ${i + 1} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// ── PARSE MATRIX SMDR LINE ────────────────────────────────────────────────
function parseSMDR(line) {
  if (!line) return null;
  const trimmedLine = line.trim();
  if (!trimmedLine) return null;

  // Matrix Eternity SMDR lines can be fixed-width (70+ chars) or space-delimited
  // Let's try space-delimited first if it looks like the user's reported format:
  // [ID] [Date] [Time] [Duration] [Type] [Number] [Ext]
  const parts = trimmedLine.split(/\s+/);

  let record = null;

  if (parts.length >= 6) {
    // Check if parts[1] looks like a date (DD-MM-YY or YYYY-MM-DD)
    const isDate = /^\d{2,4}-\d{2}-\d{2}$/.test(parts[1]);
    const isTime = /^\d{2}:\d{2}:\d{2}$/.test(parts[2]);

    if (isDate && isTime) {
      // Space-delimited format detected
      console.log(`[SMDR] ℹ️  Space-delimited format detected (${parts.length} parts)`);

      let rawDate = parts[1];
      let rawTime = parts[2];
      let rawDur = parts[3]; // Might be HH:MM:SS or seconds
      let type = parts[4] || 'Out';
      let num = parts[5] || '';
      let ext = parts[6] || '';

      // Normalize Date
      let callDate = rawDate;
      if (rawDate.includes('-')) {
        const dp = rawDate.split('-');
        if (dp[0].length === 2 && dp[2].length === 2) { // DD-MM-YY
          callDate = `20${dp[2]}-${dp[1].padStart(2, '0')}-${dp[0].padStart(2, '0')}`;
        } else if (dp[0].length === 4) { // YYYY-MM-DD
          callDate = rawDate;
        }
      }

      // Normalize Duration
      let duration = rawDur;
      if (!rawDur.includes(':')) {
        const sec = parseInt(rawDur) || 0;
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        duration = [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
      }

      record = {
        call_date: callDate,
        call_time: rawTime,
        duration: duration,
        call_type: type,
        caller: (type === 'In') ? num : ext,
        extension: ext || (type === 'Out' ? ext : num),
        destination: (type === 'In') ? ext : num,
        trunk: null,
        raw_line: trimmedLine,
        recording_file: `${callDate.slice(6, 10)}/${callDate.slice(3, 5)}/${recordingId}`,
      };
    }
  }

  // ── ATTEMPT 2: Fixed-Width Parsing (For Matrix SARVAM / ETERNITY) ──────
  // Note: We use the raw line (not trimmed) because Matrix depends on exact column positions.
  const rawLine = line;
  if (rawLine.length >= 70) {
    const getFixed = (start, len) => rawLine.substring(start - 1, (start - 1) + len).trim();
    const parsedLayout = parseMatrixFixedLayout(rawLine);
    if (!parsedLayout) return null;

    const callingNum = parsedLayout.callingNum;
    const trunk = parsedLayout.trunk;
    const connectedNum = parsedLayout.connectedNum;
    const rawDate = parsedLayout.rawDate;
    const rawTime = parsedLayout.rawTime;
    const speechSec = parsedLayout.durationSeconds;

    // RECORDING FILENAME: Standard Matrix position is usually 80+ if enabled
    const recordingId = rawLine.length > 80 ? getFixed(80, 30) : null;

    // VALIDATION: If the date or time fields contain dashes or non-digits, it's a summary line
    if (!rawDate || rawDate.includes('-') && rawDate.length < 5 || rawTime.includes('-')) {
      return null;
    }

    const callDate = parseMatrixDate(rawDate);

    const duration = formatDurationFromSeconds(speechSec);

    let type = 'Out';
    if (callingNum.length > 5) type = 'In';
    else if (connectedNum.length <= 5 && connectedNum.length > 0) type = 'Internal';

    record = {
      call_date: callDate,
      call_time: rawTime || null,
      duration: duration,
      call_type: type,
      caller: callingNum || null,
      extension: (type === 'Out' || type === 'Internal') ? callingNum : connectedNum,
      destination: connectedNum,
      trunk: trunk || null,
      raw_line: rawLine.trim(),
      recording_file: `${callDate.slice(6, 10)}/${callDate.slice(3, 5)}/${recordingId}`
    };

    if (type === 'In') {
      record.caller = callingNum;
      record.destination = connectedNum;
      record.extension = connectedNum;
    }
  }

  if (record && record.call_time && !record.call_time.includes('-')) {
    console.log(`[SMDR] ✅ Parsed successfully: ${record.call_type} | ${record.caller} -> ${record.destination}`);
    return record;
  }

  return null;
}

// ── SAVE TO DB ────────────────────────────────────────────────────────────
async function saveCallLog(record) {
  try {
    // ── RECORDING FILE DEDUPE ─────────────────────────────
    if (record.recording_file && record.recording_file.trim()) {
      const existingRecording = await pool.query(`
        SELECT id
        FROM call_logs
        WHERE recording_file = $1
        LIMIT 1
      `, [record.recording_file.trim()]);

      if (existingRecording.rowCount) {
        console.log(`[SMDR] Duplicate recording ignored: ${record.recording_file}`);
        return existingRecording.rows[0];
      }
    }
    const dedupeKey = normaliseSmdrLineForDedupe(record.raw_line);
    if (dedupeKey) {
      const existing = await pool.query(`
        SELECT id
        FROM call_logs
        WHERE raw_line IS NOT NULL
          AND regexp_replace(trim(raw_line), '^\\d+\\s+', '') = $1
        LIMIT 1
      `, [dedupeKey]);
      if (existing.rowCount) {
        console.log(`[SMDR] Duplicate raw event ignored (existing ID: ${existing.rows[0].id})`);
        return existing.rows[0];
      }
    }

    // Strip null bytes and non-printable characters to prevent DB UTF-8 encoding errors
    const cleanRawLine = String(record.raw_line || '').replace(/\x00/g, '').replace(/[\x01-\x1F\x7F-\x9F]/g, ' ').trim();

    const result = await pool.query(`
      INSERT INTO call_logs (call_date, call_time, duration, call_type, caller, extension, destination, trunk, raw_line, recording_file)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      record.call_date, record.call_time, record.duration,
      record.call_type, record.caller, record.extension,
      record.destination, record.trunk, cleanRawLine,
      record.recording_file
    ]);
    const row = result.rows[0];
    console.log(`[SMDR] Saved to call_logs: ${record.call_type} | ${record.caller} → ${record.destination}`);

    // ── SYNC WITH CRM CONTACTS ──────────────────────────────────────────
    const externalNum = (record.call_type === 'In') ? record.caller : record.destination;

    if (externalNum && externalNum.length > 5) {
      // Normalize number for search (remove spaces, match last 10 digits or +91)
      const cleanNum = externalNum.replace(/\s+/g, '');
      const last10 = cleanNum.slice(-10);

      const updateResult = await pool.query(`
        UPDATE contacts 
        SET calls = COALESCE(calls, 0) + 1,
            last_contact = $1
        WHERE phone LIKE $2 OR wa LIKE $2 OR phone LIKE $3 OR wa LIKE $3
        RETURNING id, fname, lname
      `, [
        new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
        `%${last10}`,
        `%${cleanNum}%`
      ]);

      if (updateResult.rowCount > 0) {
        updateResult.rows.forEach(c => {
          console.log(`[SMDR] 📈 Incremented call count for CRM contact: ${c.fname} ${c.lname} (ID: ${c.id})`);
        });
      }
    }

    emit('pbx:call', row);
    return row;
  } catch (err) {
    console.error('[SMDR] DB save error:', err.message);
  }
}

// ── PROCESS BUFFER ────────────────────────────────────────────────────────
function processBuffer() {
  if (!buffer.includes('\n')) {
    if (buffer.length > 0) {
      console.log(`[SMDR] ⏳ Buffer accumulating (${buffer.length} bytes), but no newline character (\\n) found yet.`);
      console.log(`[SMDR]    Current Buffer Hex: ${Buffer.from(buffer).toString('hex')}`);
    }
    return;
  }
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete last line
  for (const line of lines) {
    if (!line || line.trim().length < 10) continue;

    // Ignore explicit header/summary lines
    if (line.includes('---') || line.includes('Total Calls') || line.includes('Trunk    :') || line.includes('Page :')) {
      continue;
    }

    console.log('[SMDR] 📋 Raw line:', JSON.stringify(line));
    const record = parseSMDR(line);
    if (record) {
      console.log('[SMDR] ✅ Parsed:', JSON.stringify(record));
      saveCallLog(record);
    }
  }
}

// ── TCP CLIENT — Proactively connect TO the PBX ──────────────────────────
let smdrClient = null;
let clientRetryTimer = null;

function startClient() {
  if (smdrClient) {
    try { smdrClient.destroy(); } catch (_) { }
    smdrClient = null;
  }

  console.log('[SMDR] ── startClient() ──────────────────────────────────');
  console.log(`[SMDR]   Attempting to connect to Matrix PBX at ${PBX_HOST}:${SMDR_PORT}...`);
  console.log('[SMDR]   PBX setup: System → SMDR Settings → Output: TCP Client');
  console.log('[SMDR]              (Or PBX acting as a TCP Server)');

  smdrClient = new net.Socket();
  smdrClient.setTimeout(10000);

  smdrClient.connect(SMDR_PORT, PBX_HOST, () => {
    isConnected = true;
    console.log('[SMDR] ── OUTBOUND CONNECTION SUCCESS ─────────────────────');
    console.log(`[SMDR]   Connected to PBX at ${PBX_HOST}:${SMDR_PORT}`);
    emit('pbx:connected', { host: PBX_HOST, port: SMDR_PORT, mode: 'client' });

    if (clientRetryTimer) {
      clearInterval(clientRetryTimer);
      clientRetryTimer = null;
    }
  });

  smdrClient.on('data', (data) => {
    const raw = data.toString();
    console.log(`[SMDR] 📥 Data from PBX (${data.length} bytes): ${JSON.stringify(raw)}`);
    buffer += raw;
    processBuffer();
  });

  smdrClient.on('close', () => {
    if (isConnected) {
      console.log('[SMDR] ── OUTBOUND DISCONNECTED ──────────────────────────');
      isConnected = false;
      emit('pbx:disconnected', {});
    }
    // Schedule retry if not already scheduled
    if (!clientRetryTimer) {
      console.log('[SMDR]   Retrying outbound connection in 30s...');
      clientRetryTimer = setInterval(startClient, 30000);
    }
  });

  smdrClient.on('error', (err) => {
    // Only log first error, then suppress repeated connection refused errors
    if (err.code === 'ECONNREFUSED' && !smdrClient._firstErrorLogged) {
      console.error(`[SMDR] ⚠️  PBX not reachable at ${PBX_HOST}:${SMDR_PORT} (will retry silently every 30s)`);
      smdrClient._firstErrorLogged = true;
    } else if (err.code !== 'ECONNREFUSED') {
      console.error(`[SMDR] ⚠️  Outbound client error: ${err.message} (code=${err.code})`);
    }
    emit('pbx:binding_error', {
      service: 'matrixSmdr',
      mode: 'client',
      error: err.message,
      code: err.code,
      host: PBX_HOST,
      port: SMDR_PORT
    });
    // Close will handle the retry
  });

  smdrClient.on('timeout', () => {
    console.warn('[SMDR] ⏱️  Outbound client timeout — no data from PBX');
    emit('pbx:binding_error', {
      service: 'matrixSmdr',
      mode: 'client',
      error: 'Connection timeout',
      host: PBX_HOST,
      port: SMDR_PORT
    });
    smdrClient.destroy();
  });
}

// ── TCP SERVER — PBX connects TO us ──────────────────────────────────────
let tcpServer = null;
let connectedPeers = 0;  // track simultaneous connections

function startServer() {
  if (tcpServer) { try { tcpServer.close(); } catch (_) { } }

  console.log('[SMDR] ── startServer() ──────────────────────────────────');
  console.log(`[SMDR]   Binding TCP server on 0.0.0.0:${SMDR_PORT}`);
  console.log(`[SMDR]   Verify PBX_HOST : "${PBX_HOST}" (Type: ${typeof PBX_HOST})`);
  if (PBX_HOST === '192.168.0.205') {
    console.error('[SMDR] ⚠️  CRITICAL CONFIG ERROR: PBX_HOST is set to the Tower Server IP (192.168.0.205).');
    console.error('[SMDR]    It MUST be set to the PBX Hardware IP (likely 192.168.0.81).');
  }

  // Debug: Ensure port is open in Windows Firewall
  console.log('[SMDR]   💡 HINT: Run `netsh advfirewall firewall add rule name="PBX-SMDR" dir=in action=allow protocol=TCP localport=5001` if connection is timed out.');

  tcpServer = net.createServer((socket) => {
    connectedPeers++;
    isConnected = true;
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    const isPBX = socket.remoteAddress === PBX_HOST ||
      socket.remoteAddress === `::ffff:${PBX_HOST}`;

    console.log('[SMDR] ── INBOUND CONNECTION ─────────────────────────────');
    console.log(`[SMDR]   Remote  : ${remote}`);
    console.log(`[SMDR]   Is PBX? : ${isPBX ? '✅ YES — matches PBX_HOST (' + PBX_HOST + ')' : '⚠️  NO  — unexpected source (PBX_HOST=' + PBX_HOST + ')'}`);
    console.log(`[SMDR]   Socket  : readable=${socket.readable} writable=${socket.writable}`);
    console.log(`[SMDR]   Active connections: ${connectedPeers}`);
    if (!isPBX) {
      console.warn(`[SMDR]   ⚠️  Connection from unknown host ${socket.remoteAddress} — check PBX_HOST in .env`);
    }
    emit('pbx:connected', { host: socket.remoteAddress, port: SMDR_PORT, mode: 'server' });

    socket.on('data', (data) => {
      const raw = data.toString();
      console.log(`[SMDR] 📥 Data from ${remote} (${data.length} bytes): ${JSON.stringify(raw)}`);
      buffer += raw;
      processBuffer();
    });

    socket.on('close', (hadError) => {
      connectedPeers = Math.max(0, connectedPeers - 1);
      isConnected = connectedPeers > 0 || (smdrClient && !smdrClient.destroyed);
      console.log('[SMDR] ── INBOUND DISCONNECTED ───────────────────────────');
      console.log(`[SMDR]   Remote  : ${remote}`);
      console.log(`[SMDR]   hadError: ${hadError}`);
      console.log(`[SMDR]   Active connections remaining: ${connectedPeers}`);
      console.log(`[SMDR]   No PBX connections — waiting for Matrix PBX to reconnect...`);
      emit('pbx:disconnected', { fatal: false, reason: 'Peer disconnected', peers: connectedPeers });
    });

    socket.on('error', (err) => {
      console.error(`[SMDR] ❌ Socket error from ${remote}: ${err.message} (code=${err.code})`);
      emit('pbx:binding_error', {
        service: 'matrixSmdr',
        mode: 'server_socket',
        error: err.message,
        code: err.code,
        remote: remote
      });
    });
  });

  tcpServer.listen(SMDR_PORT, '0.0.0.0', () => {
    console.log('[SMDR] ── SERVER READY ───────────────────────────────────');
    console.log(`[SMDR]   ✅ Listening on 0.0.0.0:${SMDR_PORT}`);
    console.log('[SMDR]   Waiting for Matrix PBX (192.168.0.81) to initiate TCP handshake...');
    emit('pbx:ready', { mode: 'server', port: SMDR_PORT });
  });

  // Heartbeat to keep logs moving and show service is alive
  if (global.smdrHeartbeat) clearInterval(global.smdrHeartbeat);
  global.smdrHeartbeat = setInterval(() => {
    if (connectedPeers === 0) {
      console.log(`[SMDR] 💓 Heartbeat: Still listening on port ${SMDR_PORT}... (No active PBX connection yet)`);
    } else {
      console.log(`[SMDR] 💓 Heartbeat: Active connection maintained. (Peers: ${connectedPeers})`);
    }
  }, 60000);

  tcpServer.on('error', (err) => {
    console.error('[SMDR] ❌ Server error:', err.message, `(code=${err.code})`);
    emit('pbx:disconnected', {
      service: 'matrixSmdr',
      mode: 'server',
      fatal: true,
      error: err.message,
      code: err.code,
      port: SMDR_PORT
    });
    if (err.code === 'EADDRINUSE') {
      console.error(`[SMDR]   Port ${SMDR_PORT} already in use.`);
    }
    console.log('[SMDR]   Retrying server in 30 seconds...');
    setTimeout(startServer, 30000);
  });
}

function getStatus() {
  return { connected: isConnected, host: PBX_HOST, port: SMDR_PORT, peers: connectedPeers };
}

async function start() {
  await ensureTable();
  // We only start the Server mode because the Matrix PBX is configured to PUSH data to us.
  // This avoids the ECONNREFUSED error when trying to connect to the PBX as a client.
  startServer();
  // startClient(); 
}


/**
 * Click-to-Dial via Matrix CTI Port
 * @param {string} sourceExt - The internal extension to start the call from
 * @param {string} destination - The number to dial
 */
async function dial(sourceExt, destination) {
  return new Promise((resolve, reject) => {
    if (!sourceExt || !destination) return reject(new Error('Source extension and destination required'));

    console.log(`[CTI] Attempting Click-to-Dial: ${sourceExt} → ${destination}`);

    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(CTI_PORT, PBX_HOST, () => {
      // Matrix Eternity CTI Command: CALL <SrcExt> <DestNum>
      // Some versions require a password or specific login, but basic CTI often allows direct CALL.
      const cmd = `CALL ${sourceExt} ${destination}\r\n`;
      client.write(cmd);
      console.log(`[CTI] Sent: ${cmd.trim()}`);
    });

    client.on('data', (data) => {
      const resp = data.toString().trim();
      console.log(`[CTI] Response: ${resp}`);
      client.destroy();
      resolve(resp);
    });

    client.on('error', (err) => {
      console.error(`[CTI] Connection error: ${err.message}`);
      client.destroy();
      reject(err);
    });

    client.on('timeout', () => {
      console.error('[CTI] Connection timed out');
      client.destroy();
      reject(new Error('CTI timeout'));
    });
  });
}

async function reconnect() {
  console.log('[SMDR] 🔄 Manual reconnect requested...');

  // Close outbound client
  if (smdrClient) {
    try { smdrClient.destroy(); } catch (_) { }
    smdrClient = null;
  }
  if (clientRetryTimer) {
    clearInterval(clientRetryTimer);
    clientRetryTimer = null;
  }

  // Close inbound server
  if (tcpServer) {
    try {
      tcpServer.close();
      console.log('[SMDR] Inbound server closed for restart');
    } catch (_) { }
    tcpServer = null;
  }

  isConnected = false;
  connectedPeers = 0;
  emit('pbx:disconnected', { reason: 'manual_reconnect' });

  // Small delay then restart
  setTimeout(() => {
    start();
  }, 1000);
}

module.exports = { start, setIO, getStatus, dial, reconnect };
