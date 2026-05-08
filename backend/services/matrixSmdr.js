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
const net  = require('net');
const pool = require('../db/pool');

// ── CONFIG (from .env) ────────────────────────────────────────────────────
const PBX_HOST  = process.env.PBX_HOST  || '192.168.0.81';
const SMDR_PORT = parseInt(process.env.SMDR_PORT || '5000');
const CTI_PORT  = parseInt(process.env.CTI_PORT  || '5001');

// ── STARTUP CONFIG DUMP ───────────────────────────────────────────────────
console.log('[SMDR] ══════════════════════════════════════════════════════');
console.log('[SMDR] Matrix Eternity CTI — configuration check');
console.log(`[SMDR]   PBX_HOST  : ${PBX_HOST}  (Matrix Eternity IP)`);
console.log(`[SMDR]   SMDR_PORT : ${SMDR_PORT}  (PBX → this server, raw call records)`);
console.log(`[SMDR]   CTI_PORT  : ${CTI_PORT}  (click-to-dial / call control)`);
console.log('[SMDR]   Source    : process.env (SMDR_PORT=' +
  (process.env.SMDR_PORT ? process.env.SMDR_PORT + ' ✅ set in .env' : 'NOT SET — using default 5000 ⚠️') + ')');
console.log('[SMDR]   Source    : process.env (CTI_PORT=' +
  (process.env.CTI_PORT  ? process.env.CTI_PORT  + ' ✅ set in .env' : 'NOT SET — using default 5001 ⚠️') + ')');
console.log('[SMDR] ══════════════════════════════════════════════════════');

let io          = null;
let isConnected = false;
let buffer      = '';

function setIO(socketIO) { io = socketIO; }

function emit(event, data) {
  if (io) io.emit(event, data);
}

// ── ENSURE TABLE ──────────────────────────────────────────────────────────
async function ensureTable() {
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
    await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ${name} ${col.split(' ').slice(1).join(' ')}`).catch(() => {});
  }
}

// ── PARSE MATRIX SMDR LINE ────────────────────────────────────────────────
// Matrix Eternity SMDR format (space/tab delimited):
// Date      Time     Duration  Type  Ext   Trunk  Destination
// 30/04/26  14:23:45  00:02:15  OUT   201   T1     9198765XXXXX
//
// Some versions use fixed-width, some use comma/tab. We handle both.
function parseSMDR(line) {
  line = line.trim();
  if (!line || line.length < 10) return null;

  // Try comma-separated first
  let parts;
  if (line.includes(',')) {
    parts = line.split(',').map(s => s.trim());
  } else {
    // Split on 2+ spaces or tabs
    parts = line.split(/\s{2,}|\t/).map(s => s.trim()).filter(Boolean);
  }

  if (parts.length < 4) return null;

  // Matrix Eternity typical field order:
  // [0] Date (DD/MM/YY or DD-MM-YYYY)
  // [1] Time (HH:MM:SS)
  // [2] Duration (HH:MM:SS or MM:SS)
  // [3] Call Type (IN/OUT/INT/MISSED)
  // [4] Extension / Caller
  // [5] Trunk (T1, T2, SIP1 etc)
  // [6] Destination / Called number

  const rawDate = parts[0] || '';
  const rawTime = parts[1] || '';
  const duration = parts[2] || '';
  const callType = (parts[3] || '').toUpperCase();
  const ext = parts[4] || '';
  const trunk = parts[5] || '';
  const destination = parts[6] || '';

  // Parse date
  let callDate = null;
  try {
    // Handle DD/MM/YY or DD/MM/YYYY or DD-MM-YYYY
    const d = rawDate.replace(/-/g, '/');
    const dp = d.split('/');
    if (dp.length === 3) {
      const yr = dp[2].length === 2 ? '20' + dp[2] : dp[2];
      callDate = `${yr}-${dp[1].padStart(2,'0')}-${dp[0].padStart(2,'0')}`;
    }
  } catch (_) {}

  // Determine call type label
  let type = 'Out';
  if (callType.includes('IN'))     type = 'In';
  else if (callType.includes('OUT')) type = 'Out';
  else if (callType.includes('INT') || callType.includes('INTERNAL')) type = 'Internal';
  else if (callType.includes('MISS')) type = 'Missed';

  // Caller: for outgoing = extension, for incoming = destination field may have CLI
  const caller = type === 'In' ? destination : ext;
  const dest   = type === 'In' ? ext : destination;

  return {
    call_date:   callDate,
    call_time:   rawTime || null,
    duration:    duration || null,
    call_type:   type,
    caller:      caller || null,
    extension:   ext || null,
    destination: dest || null,
    trunk:       trunk || null,
    raw_line:    line,
  };
}

// ── SAVE TO DB ────────────────────────────────────────────────────────────
async function saveCallLog(record) {
  try {
    const result = await pool.query(`
      INSERT INTO call_logs (call_date, call_time, duration, call_type, caller, extension, destination, trunk, raw_line)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      record.call_date, record.call_time, record.duration,
      record.call_type, record.caller, record.extension,
      record.destination, record.trunk, record.raw_line
    ]);
    const row = result.rows[0];
    console.log(`[SMDR] Saved: ${record.call_type} | ${record.caller} → ${record.destination} | ${record.duration}`);
    emit('pbx:call', row);
    return row;
  } catch (err) {
    console.error('[SMDR] DB save error:', err.message);
  }
}

// ── PROCESS BUFFER ────────────────────────────────────────────────────────
function processBuffer() {
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete last line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    console.log('[SMDR] 📋 Raw line:', JSON.stringify(trimmed));
    const record = parseSMDR(trimmed);
    if (record) {
      console.log('[SMDR] ✅ Parsed:', JSON.stringify(record));
      saveCallLog(record);
    } else {
      console.log('[SMDR] ⚠️ Could not parse line — check SMDR format');
    }
  }
}

// ── TCP SERVER — PBX connects TO us ──────────────────────────────────────
let tcpServer     = null;
let connectedPeers = 0;  // track simultaneous connections

function startServer() {
  if (tcpServer) { try { tcpServer.close(); } catch (_) {} }

  console.log('[SMDR] ── startServer() ──────────────────────────────────');
  console.log(`[SMDR]   Binding TCP server on 0.0.0.0:${SMDR_PORT}`);
  console.log(`[SMDR]   Expecting Matrix PBX at ${PBX_HOST} to connect`);
  console.log('[SMDR]   PBX setup: System → SMDR Settings → Output: TCP Server');
  console.log(`[SMDR]              SMDR Port must be set to ${SMDR_PORT} on the PBX`);

  tcpServer = net.createServer((socket) => {
    connectedPeers++;
    isConnected = true;
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    const isPBX  = socket.remoteAddress === PBX_HOST ||
                   socket.remoteAddress === `::ffff:${PBX_HOST}`;

    console.log('[SMDR] ── INBOUND CONNECTION ─────────────────────────────');
    console.log(`[SMDR]   Remote  : ${remote}`);
    console.log(`[SMDR]   Is PBX? : ${isPBX ? '✅ YES — matches PBX_HOST (' + PBX_HOST + ')' : '⚠️  NO  — unexpected source (PBX_HOST=' + PBX_HOST + ')'}`);
    console.log(`[SMDR]   Socket  : readable=${socket.readable} writable=${socket.writable}`);
    console.log(`[SMDR]   Active connections: ${connectedPeers}`);
    if (!isPBX) {
      console.warn(`[SMDR]   ⚠️  Connection from unknown host ${socket.remoteAddress} — check PBX_HOST in .env`);
    }
    emit('pbx:connected', { host: PBX_HOST, port: SMDR_PORT });

    socket.on('data', (data) => {
      const raw = data.toString();
      console.log(`[SMDR] 📥 Data from ${remote} (${data.length} bytes): ${JSON.stringify(raw)}`);
      buffer += raw;
      processBuffer();
    });

    socket.on('close', (hadError) => {
      connectedPeers = Math.max(0, connectedPeers - 1);
      isConnected    = connectedPeers > 0;
      console.log('[SMDR] ── DISCONNECTED ───────────────────────────────────');
      console.log(`[SMDR]   Remote  : ${remote}`);
      console.log(`[SMDR]   hadError: ${hadError}`);
      console.log(`[SMDR]   Active connections remaining: ${connectedPeers}`);
      if (!isConnected) {
        console.log('[SMDR]   No PBX connections — waiting for Matrix PBX to reconnect...');
        console.log(`[SMDR]   Verify PBX SMDR output is set to TCP Server → ${SMDR_PORT}`);
      }
      emit('pbx:disconnected', {});
    });

    socket.on('error', (err) => {
      console.error(`[SMDR] ⚠️  Socket error from ${remote}: ${err.message} (code=${err.code})`);
      if (err.code === 'ECONNRESET') {
        console.error('[SMDR]   PBX reset the connection — may be a PBX restart or config change');
      }
    });

    socket.on('timeout', () => {
      console.warn(`[SMDR] ⏱️  Socket timeout from ${remote} — no data received`);
      console.warn('[SMDR]   Check PBX SMDR is enabled and sending data');
    });
  });

  tcpServer.listen(SMDR_PORT, '0.0.0.0', () => {
    console.log('[SMDR] ── SERVER READY ───────────────────────────────────');
    console.log(`[SMDR]   ✅ Listening on 0.0.0.0:${SMDR_PORT}`);
    console.log(`[SMDR]   Waiting for Matrix PBX (${PBX_HOST}) to connect...`);
    console.log('[SMDR]   If PBX does not connect within 60s, check:');
    console.log(`[SMDR]     1. PBX SMDR output IP = this machine's LAN IP`);
    console.log(`[SMDR]     2. PBX SMDR port      = ${SMDR_PORT}`);
    console.log(`[SMDR]     3. Windows Firewall inbound rule for TCP ${SMDR_PORT}`);
    console.log('[SMDR]        Run as admin: New-NetFirewallRule -DisplayName "UniComm SMDR"');
    console.log(`[SMDR]          -Direction Inbound -Protocol TCP -LocalPort ${SMDR_PORT} -Action Allow`);
  });

  tcpServer.on('error', (err) => {
    console.error('[SMDR] ❌ Server error:', err.message, `(code=${err.code})`);
    if (err.code === 'EADDRINUSE') {
      console.error(`[SMDR]   Port ${SMDR_PORT} already in use.`);
      console.error('[SMDR]   Find the process: netstat -ano | findstr :' + SMDR_PORT);
      console.error('[SMDR]   Kill it:          taskkill /PID <pid> /F');
    }
    if (err.code === 'EACCES') {
      console.error(`[SMDR]   Permission denied on port ${SMDR_PORT} — ports below 1024 need admin`);
    }
    console.log('[SMDR]   Retrying in 10 seconds...');
    setTimeout(startServer, 10000);
  });
}

function getStatus() {
  return { connected: isConnected, host: PBX_HOST, port: SMDR_PORT };
}

async function start() {
  await ensureTable();
  startServer();
}

module.exports = { start, setIO, getStatus };
