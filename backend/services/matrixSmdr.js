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

function cleanText(value) {
  return String(value || '')
    .replace(/\x00/g, '')
    .replace(/[\x01-\x1F\x7F-\x9F]/g, ' ')
    .trim();
}

function cleanNullableText(value) {
  const cleaned = cleanText(value);
  return cleaned ? cleaned : null;
}

// ── CONFIG (from .env) ────────────────────────────────────────────────────
const PBX_HOST = process.env.PBX_HOST || '192.168.0.81';
const SMDR_PORT = parseInt(process.env.SMDR_PORT || '5000');
const CTI_PORT = parseInt(process.env.CTI_PORT || '5001');

// ── DEEP DEBUG: CONFIG VALIDATION ──────────────────────────────────────────
console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
console.log('[SMDR-DEBUG] ║ MATRIX SMDR SERVICE — INITIALIZATION DEBUG              ║');
console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

console.log('[SMDR-DEBUG] 📋 STEP 1: Environment Configuration Validation');
console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
console.log(`[SMDR-DEBUG]   process.env.PBX_HOST      = "${process.env.PBX_HOST}"`);
console.log(`[SMDR-DEBUG]   process.env.SMDR_PORT     = "${process.env.SMDR_PORT}"`);
console.log(`[SMDR-DEBUG]   process.env.CTI_PORT      = "${process.env.CTI_PORT}"`);
console.log(`[SMDR-DEBUG]   process.env.NODE_ENV      = "${process.env.NODE_ENV}"`);
console.log(`[SMDR-DEBUG]   process.env.HOST          = "${process.env.HOST}"`);

console.log('\n[SMDR-DEBUG] 📋 STEP 2: Parsed Configuration Values');
console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
console.log(`[SMDR-DEBUG]   PBX_HOST (final)          = "${PBX_HOST}" (type: ${typeof PBX_HOST})`);
console.log(`[SMDR-DEBUG]   SMDR_PORT (final)         = ${SMDR_PORT} (type: ${typeof SMDR_PORT})`);
console.log(`[SMDR-DEBUG]   CTI_PORT (final)          = ${CTI_PORT} (type: ${typeof CTI_PORT})`);

console.log('\n[SMDR-DEBUG] 📋 STEP 3: Configuration Validation Checks');
console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');

// Validate PBX_HOST
if (!PBX_HOST || PBX_HOST.trim() === '') {
  console.error('[SMDR-DEBUG] ❌ CRITICAL: PBX_HOST is empty or undefined!');
} else if (false && PBX_HOST === '192.168.0.205') {
  console.error('[SMDR-DEBUG] ❌ CRITICAL: PBX_HOST is set to Tower Server IP (192.168.0.205)');
  console.error('[SMDR-DEBUG]    This is WRONG. PBX_HOST must be the PBX hardware IP (192.168.0.81)');
} else if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(PBX_HOST)) {
  console.error(`[SMDR-DEBUG] ❌ CRITICAL: PBX_HOST "${PBX_HOST}" is not a valid IP address`);
} else {
  console.log(`[SMDR-DEBUG] ✅ PBX_HOST is valid: ${PBX_HOST}`);
}

// Validate SMDR_PORT
if (isNaN(SMDR_PORT)) {
  console.error('[SMDR-DEBUG] ❌ CRITICAL: SMDR_PORT is not a number!');
} else if (SMDR_PORT < 1 || SMDR_PORT > 65535) {
  console.error(`[SMDR-DEBUG] ❌ CRITICAL: SMDR_PORT ${SMDR_PORT} is out of valid range (1-65535)`);
} else if (SMDR_PORT < 1024) {
  console.warn(`[SMDR-DEBUG] ⚠️  WARNING: SMDR_PORT ${SMDR_PORT} is a privileged port (< 1024)`);
} else {
  console.log(`[SMDR-DEBUG] ✅ SMDR_PORT is valid: ${SMDR_PORT}`);
}

// Validate CTI_PORT
if (isNaN(CTI_PORT)) {
  console.error('[SMDR-DEBUG] ❌ CRITICAL: CTI_PORT is not a number!');
} else if (CTI_PORT < 1 || CTI_PORT > 65535) {
  console.error(`[SMDR-DEBUG] ❌ CRITICAL: CTI_PORT ${CTI_PORT} is out of valid range (1-65535)`);
} else {
  console.log(`[SMDR-DEBUG] ✅ CTI_PORT is valid: ${CTI_PORT}`);
}

// Check for port conflicts
if (SMDR_PORT === CTI_PORT) {
  console.warn(`[SMDR-DEBUG] ⚠️  WARNING: SMDR_PORT and CTI_PORT are the same (${SMDR_PORT})`);
  console.warn('[SMDR-DEBUG]    This is allowed but unusual. Ensure PBX is configured correctly.');
}

console.log('\n[SMDR-DEBUG] 📋 STEP 4: Network Configuration Summary');
console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
console.log('[SMDR-DEBUG] Expected Connection Flow:');
console.log(`[SMDR-DEBUG]   PBX (${PBX_HOST}) → TCP Server (0.0.0.0:${SMDR_PORT})`);
console.log('[SMDR-DEBUG]   Protocol: OG-Handshaking (ENQ/ACK handshake)');
console.log('[SMDR-DEBUG]   Data Format: STX (0x02) + SMDR Records + ETX (0x03)');
console.log('[SMDR-DEBUG] ═════════════════════════════════════════════════════════\n');

let io = null;
let isConnected = false;
let buffer = '';
let lastSavedCallTime = null;
let lastRawDataTime = null;
let savedCallCount = 0;
let parseFailureCount = 0;

const MATRIX_ENQ = 0x00;
const MATRIX_ACK = 0x06;
const MATRIX_STX = 0x02;
const MATRIX_ETX = 0x03;

function safelyAckMatrixPacket(socket, reason) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(Buffer.from([MATRIX_ACK]));
    console.log(`[SMDR-DEBUG] ✅ ACK (0x06) sent for ${reason}`);
    return true;
  } catch (err) {
    console.warn(`[SMDR-DEBUG] ⚠️  Failed to send ACK for ${reason}: ${err.message}`);
    return false;
  }
}

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
  return /^\d{1,2}[-/\.]\d{2}[-/\.]\d{2,4}$/.test(String(value || '').trim());
}

function isMatrixTime(value) {
  return /^\d{2}:\d{2}:\d{2}$/.test(String(value || '').trim());
}

function parseMatrixDate(rawDate) {
  const dp = String(rawDate || '').trim().split(/[-/\.]/);
  if (dp.length !== 3) return null;
  const yr = dp[2].length === 2 ? '20' + dp[2] : dp[2];
  return `${yr}-${dp[1].padStart(2, '0')}-${dp[0].padStart(2, '0')}`;
}

function looksLikeMatrixCallRecord(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return false;

  // Sarvam/Matrix call rows start with a sequence number followed by an
  // extension/external number. System/debug records can contain dates and
  // times, but should never be inserted into call_logs as calls.
  if (/^\d{1,6}\s+(?:\+?\d{2,}|[A-Z]\d{3,})\b/.test(line)) return true;

  const parts = line.split(/\s+/);
  if (parts.length >= 6 && isMatrixDate(parts[1]) && isMatrixTime(parts[2])) {
    return /^(In|Out|Internal|Missed)$/i.test(parts[4] || '');
  }

  return false;
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
	)
      `);
      // Add columns if they don't exist (for existing tables)
      const cols = [
  	'call_date DATE',
  	'call_time TIME',
  	'trunk VARCHAR(50)',
  	'raw_line TEXT',
  	'recording_file TEXT'
	];
      for (const col of cols) {
        const name = col.split(' ')[0];
        await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ${name} ${col.split(' ').slice(1).join(' ')}`).catch(() => { });
      }
      await pool.query(`UPDATE call_logs SET recording_file = NULL WHERE recording_file = ''`).catch(() => { });
      await pool.query(`DROP INDEX IF EXISTS idx_call_logs_recording_file_unique`).catch(() => { });
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_recording_file_unique
        ON call_logs (recording_file)
        WHERE recording_file IS NOT NULL AND recording_file <> ''
      `).catch(() => { });
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
  console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
  console.log('[SMDR-DEBUG] ║ SMDR RECORD PARSING — DETAILED ANALYSIS                ║');
  console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

  console.log('[SMDR-DEBUG] 📋 STEP 1: Input Validation');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  console.log(`[SMDR-DEBUG]   Line provided?           = ${line ? 'YES' : 'NO'}`);
  console.log(`[SMDR-DEBUG]   Line length              = ${line ? line.length : 0}`);
  console.log(`[SMDR-DEBUG]   Line content             = ${JSON.stringify(line)}`);

  if (!line) {
    console.log('[SMDR-DEBUG] ❌ Skipped: No line provided');
    return null;
  }

  const trimmedLine = line.trim();
  if (!trimmedLine) {
    console.log('[SMDR-DEBUG] ❌ Skipped: Line is empty after trim');
    return null;
  }

  console.log('\n[SMDR-DEBUG] 📋 STEP 2: Format Detection');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');

  if (!looksLikeMatrixCallRecord(trimmedLine)) {
    console.log('[SMDR-DEBUG] Skipped: not a Matrix call record');
    return null;
  }

  // Matrix Eternity SMDR lines can be fixed-width (70+ chars) or space-delimited
  const parts = trimmedLine.split(/\s+/);
  console.log(`[SMDR-DEBUG]   Space-delimited parts    = ${parts.length}`);
  console.log(`[SMDR-DEBUG]   Parts: ${JSON.stringify(parts)}`);

  let record = null;

  if (parts.length >= 6) {
    // Check if parts[1] looks like a date (DD-MM-YY or YYYY-MM-DD)
    const isDate = /^\d{2,4}-\d{2}-\d{2}$/.test(parts[1]);
    const isTime = /^\d{2}:\d{2}:\d{2}$/.test(parts[2]);

    console.log(`[SMDR-DEBUG]   Part[1] is date?         = ${isDate} (${parts[1]})`);
    console.log(`[SMDR-DEBUG]   Part[2] is time?         = ${isTime} (${parts[2]})`);

    const matrixPostingDateIndex = parts.findIndex((part, idx) =>
      idx > 0 && isMatrixDate(part) && isMatrixTime(parts[idx + 1])
    );

    if (!isDate && matrixPostingDateIndex >= 4) {
      console.log('[SMDR-DEBUG] Matrix Posting space-delimited format detected');

      const callingNum = parts[1] || '';
      const trunk = parts[2] || '';
      const connectedNum = parts[3] || '';
      const rawDate = parts[matrixPostingDateIndex];
      const rawTime = parts[matrixPostingDateIndex + 1];
      const tail = parts.slice(matrixPostingDateIndex + 2);
      const numericTail = tail.filter(v => /^\d+$/.test(v));
      const durationSeconds = parseInt(numericTail[numericTail.length - 1] || '0', 10) || 0;
      const callDate = parseMatrixDate(rawDate);
      const duration = formatDurationFromSeconds(durationSeconds);

      let type = 'Out';
      if (callingNum.length > 5) type = 'In';
      else if (connectedNum.length <= 5 && connectedNum.length > 0) type = 'Internal';

      record = {
        call_date: callDate,
        call_time: rawTime,
        duration: duration,
        call_type: type,
        caller: callingNum || null,
        extension: (type === 'In') ? connectedNum : callingNum,
        destination: connectedNum || null,
        trunk: trunk || null,
        raw_line: trimmedLine,
        recording_file: null
      };

      console.log('[SMDR-DEBUG] Matrix Posting record created', record);
      return record;
    }

    if (isDate && isTime) {
      console.log('[SMDR-DEBUG] ✅ Space-delimited format detected');

      let rawDate = parts[1];
      let rawTime = parts[2];
      let rawDur = parts[3];
      let type = parts[4] || 'Out';
      let num = parts[5] || '';
      let ext = parts[6] || '';

      console.log('\n[SMDR-DEBUG] 📋 STEP 3: Field Extraction');
      console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
      console.log(`[SMDR-DEBUG]   Raw Date                 = ${rawDate}`);
      console.log(`[SMDR-DEBUG]   Raw Time                 = ${rawTime}`);
      console.log(`[SMDR-DEBUG]   Raw Duration             = ${rawDur}`);
      console.log(`[SMDR-DEBUG]   Call Type                = ${type}`);
      console.log(`[SMDR-DEBUG]   Number                   = ${num}`);
      console.log(`[SMDR-DEBUG]   Extension                = ${ext}`);

      // Normalize Date
      let callDate = rawDate;
      if (rawDate.includes('-')) {
        const dp = rawDate.split('-');
        if (dp[0].length === 2 && dp[2].length === 2) { // DD-MM-YY
          callDate = `20${dp[2]}-${dp[1].padStart(2, '0')}-${dp[0].padStart(2, '0')}`;
          console.log(`[SMDR-DEBUG]   Date normalized (DD-MM-YY) = ${callDate}`);
        } else if (dp[0].length === 4) { // YYYY-MM-DD
          callDate = rawDate;
          console.log(`[SMDR-DEBUG]   Date already normalized  = ${callDate}`);
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
        console.log(`[SMDR-DEBUG]   Duration normalized      = ${duration} (from ${rawDur}s)`);
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
        recording_file: null
      };

      console.log('\n[SMDR-DEBUG] 📋 STEP 4: Record Created');
      console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
      console.log(`[SMDR-DEBUG]   ✅ Record successfully created`);
      return record;
    }
  }

  // ── ATTEMPT 2: Fixed-Width Parsing (For Matrix SARVAM / ETERNITY) ──────
  console.log('\n[SMDR-DEBUG] 📋 STEP 3: Attempting Fixed-Width Format');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  console.log(`[SMDR-DEBUG]   Line length              = ${trimmedLine.length}`);

  const rawLine = line;
  if (rawLine.length >= 70) {
    console.log('[SMDR-DEBUG] ✅ Line length sufficient for fixed-width parsing');

    const parsedLayout = parseMatrixFixedLayout(rawLine);
    if (!parsedLayout) {
      console.log('[SMDR-DEBUG] ❌ Fixed-width parsing failed');
      return null;
    }

    console.log('[SMDR-DEBUG] ✅ Fixed-width parsing successful');
    console.log(`[SMDR-DEBUG]   Layout type              = ${parsedLayout.layout}`);

    const callingNum = parsedLayout.callingNum;
    const trunk = parsedLayout.trunk;
    const connectedNum = parsedLayout.connectedNum;
    const rawDate = parsedLayout.rawDate;
    const rawTime = parsedLayout.rawTime;
    const speechSec = parsedLayout.durationSeconds;

    console.log(`[SMDR-DEBUG]   Calling Number           = ${callingNum}`);
    console.log(`[SMDR-DEBUG]   Trunk                    = ${trunk}`);
    console.log(`[SMDR-DEBUG]   Connected Number         = ${connectedNum}`);
    console.log(`[SMDR-DEBUG]   Date                     = ${rawDate}`);
    console.log(`[SMDR-DEBUG]   Time                     = ${rawTime}`);
    console.log(`[SMDR-DEBUG]   Duration (seconds)       = ${speechSec}`);

    const recordingId = rawLine.length > 80 ? rawLine.substring(79, 109).trim() : null;

    // VALIDATION: If the date or time fields contain dashes or non-digits, it's a summary line
    if (!rawDate || rawDate.includes('-') && rawDate.length < 5 || rawTime.includes('-')) {
      console.log('[SMDR-DEBUG] ❌ Invalid date/time format detected');
      return null;
    }

    const callDate = parseMatrixDate(rawDate);
    const duration = formatDurationFromSeconds(speechSec);

    let type = 'Out';
    if (callingNum.length > 5) type = 'In';
    else if (connectedNum.length <= 5 && connectedNum.length > 0) type = 'Internal';

    console.log(`[SMDR-DEBUG]   Detected call type       = ${type}`);

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
      recording_file: recordingId
        ? `${callDate.slice(0,4)}/${callDate.slice(5,7)}/${String(recordingId).trim()}`
        : null
    };

    if (type === 'In') {
      record.caller = callingNum;
      record.destination = connectedNum;
      record.extension = connectedNum;
    }

    console.log('[SMDR-DEBUG] ✅ Fixed-width record created');
    return record;
  } else {
    console.log(`[SMDR-DEBUG] ❌ Line too short for fixed-width (${rawLine.length} < 70)`);
  }

  if (record && record.call_time && !record.call_time.includes('-')) {
    console.log(`[SMDR-DEBUG] ✅ Final validation passed`);
    return record;
  }

  console.log('[SMDR-DEBUG] ❌ No valid format detected');
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

    // ── MULTI-HOP CALL DEDUPLICATION ──────────────────────
    // If a call is transferred from an IVR/Group to an extension, Matrix sends two SMDR records.
    // We combine them into a single row to prevent dashboard duplicates.
    if (record.call_type === 'In' && record.caller) {
      const recentCall = await pool.query(`
        SELECT id, destination, duration
        FROM call_logs
        WHERE call_type = 'In'
          AND caller = $1
          AND created_at >= NOW() - INTERVAL '5 minutes'
        ORDER BY id DESC
        LIMIT 1
      `, [record.caller]);

      if (recentCall.rowCount > 0) {
        const oldId = recentCall.rows[0].id;
        const oldDest = recentCall.rows[0].destination;
        console.log(`[SMDR] Multi-hop dedupe: Updating call ${oldId} (was dest ${oldDest}) with new dest ${record.destination}`);
        
        // Update the existing record with the final hop's details
        const updateResult = await pool.query(`
          UPDATE call_logs
          SET call_time = $1, duration = $2, extension = $3, destination = $4, raw_line = $5, recording_file = COALESCE($6, recording_file)
          WHERE id = $7
          RETURNING *
        `, [
          record.call_time,
          record.duration,
          cleanText(record.extension),
          cleanText(record.destination),
          cleanRawLine,
          cleanNullableText(record.recording_file),
          oldId
        ]);
        
        const row = updateResult.rows[0];
        lastSavedCallTime = new Date();
        // Emit event to update UI without duplicating Contact calls count
        emit('pbx:call', row);
        return row;
      }
    }

    const result = await pool.query(`
      INSERT INTO call_logs (call_date, call_time, duration, call_type, caller, extension, destination, trunk, raw_line, recording_file)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      record.call_date, record.call_time, record.duration,
      cleanText(record.call_type),
      cleanText(record.caller),
      cleanText(record.extension),
      cleanText(record.destination),
      cleanText(record.trunk),
      cleanRawLine,
      cleanNullableText(record.recording_file)
    ]);
    const row = result.rows[0];
    lastSavedCallTime = new Date();
    savedCallCount++;
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
  console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
  console.log('[SMDR-DEBUG] ║ BUFFER PROCESSING — SMDR RECORD PARSING                ║');
  console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

  console.log('[SMDR-DEBUG] 📋 STEP 1: Buffer Analysis');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  console.log(`[SMDR-DEBUG]   Buffer size                = ${buffer.length} bytes`);
  console.log(`[SMDR-DEBUG]   Buffer content (first 200) = ${JSON.stringify(buffer.substring(0, 200))}`);

  // Matrix PBX might send records separated by newlines, OR it might just stream them continuously.
  // We split by newlines if they exist, otherwise we split by the record sequence pattern.
  let records = [];
  if (buffer.includes('\n')) {
    records = buffer.split(/\r?\n/);
  } else {
    records = buffer.split(/(?=\s+\d{1,6}\s+[\+\d])/);
  }

  // The last chunk might be an incomplete record due to TCP fragmentation.
  const lastChunk = records.pop() || '';
  const trimmedLast = lastChunk.trim();

  const matches = [];
  for (const rec of records) {
    if (rec.trim().length >= 10) matches.push(rec.trim());
  }

  // Determine if the last chunk is actually a complete record.
  // A complete space-delimited Matrix record has at least 6 fields (Seq, Date, Time, Duration, Type, Number).
  // A fixed-width record is >= 70 characters.
  const tokens = trimmedLast.split(/\s+/);
  if (tokens.length >= 6 || trimmedLast.length >= 70) {
    // It looks complete! Push it to matches and clear the buffer.
    if (trimmedLast.length >= 10) matches.push(trimmedLast);
    buffer = '';
  } else {
    // It's incomplete! Leave it in the buffer so the next TCP packet can append to it.
    buffer = lastChunk;
    console.log(`[SMDR-DEBUG]   Keeping incomplete chunk in buffer (${lastChunk.length} bytes)`);
  }

  console.log(`[SMDR-DEBUG]   Records found (after split) = ${matches.length}`);



  console.log('\n[SMDR-DEBUG] 📋 STEP 2: Processing Records');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');

  for (let i = 0; i < matches.length; i++) {
    let line = matches[i];

    console.log(`\n[SMDR-DEBUG] Record ${i + 1}/${matches.length}:`);

    line = line
      .replace(/\x02/g, '')
      .replace(/\x03/g, '')
      .replace(/\x00/g, '')
      .replace(/[^\x20-\x7E\r\n]/g, '')
      .trim();

    console.log(`[SMDR-DEBUG]   Raw line: ${JSON.stringify(line)}`);

    if (!line || line.length < 10) {
      console.log('[SMDR-DEBUG]   ⚠️  Skipped: Line too short');
      continue;
    }

    const record = parseSMDR(line);

    if (record) {
      console.log('[SMDR-DEBUG] ✅ Parsed successfully');
      console.log(`[SMDR-DEBUG]   Type: ${record.call_type}`);
      console.log(`[SMDR-DEBUG]   Caller: ${record.caller}`);
      console.log(`[SMDR-DEBUG]   Destination: ${record.destination}`);
      console.log(`[SMDR-DEBUG]   Duration: ${record.duration}`);
      saveCallLog(record);
    } else {
      console.warn('[SMDR-DEBUG] ❌ Failed to parse record');
      console.warn(`[SMDR-DEBUG]   Line: ${JSON.stringify(line)}`);
    }
  }

  console.log('\n[SMDR-DEBUG] 📋 STEP 3: Buffer Processing Complete');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  console.log(`[SMDR-DEBUG]   Records processed: ${matches.length}`);
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
    lastActivityTime = new Date();
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
let lastActivityTime = null;  // track last SMDR record received

function startServer() {
  if (tcpServer) { try { tcpServer.close(); } catch (_) { } }

  console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
  console.log('[SMDR-DEBUG] ║ TCP SERVER STARTUP — DETAILED TRACE                    ║');
  console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

  console.log('[SMDR-DEBUG] 📋 STEP 1: Pre-Startup Validation');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  console.log(`[SMDR-DEBUG]   tcpServer exists?        = ${tcpServer ? 'YES (closing)' : 'NO'}`);
  console.log(`[SMDR-DEBUG]   SMDR_PORT value          = ${SMDR_PORT}`);
  console.log(`[SMDR-DEBUG]   SMDR_PORT type           = ${typeof SMDR_PORT}`);
  console.log(`[SMDR-DEBUG]   PBX_HOST value           = ${PBX_HOST}`);
  console.log(`[SMDR-DEBUG]   PBX_HOST type            = ${typeof PBX_HOST}`);
  console.log(`[SMDR-DEBUG]   connectedPeers           = ${connectedPeers}`);
  console.log(`[SMDR-DEBUG]   isConnected              = ${isConnected}`);

  console.log('\n[SMDR-DEBUG] 📋 STEP 2: Creating net.createServer()');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  
  try {
    tcpServer = net.createServer((socket) => {
      console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
      console.log('[SMDR-DEBUG] ║ INBOUND CONNECTION RECEIVED — DETAILED TRACE            ║');
      console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

      console.log('[SMDR-DEBUG] 📋 STEP 1: Socket Object Analysis');
      console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
      console.log(`[SMDR-DEBUG]   socket.remoteAddress     = "${socket.remoteAddress}"`);
      console.log(`[SMDR-DEBUG]   socket.remotePort        = ${socket.remotePort}`);
      console.log(`[SMDR-DEBUG]   socket.localAddress      = "${socket.localAddress}"`);
      console.log(`[SMDR-DEBUG]   socket.localPort         = ${socket.localPort}`);
      console.log(`[SMDR-DEBUG]   socket.readable          = ${socket.readable}`);
      console.log(`[SMDR-DEBUG]   socket.writable          = ${socket.writable}`);
      console.log(`[SMDR-DEBUG]   socket.destroyed         = ${socket.destroyed}`);
      console.log(`[SMDR-DEBUG]   socket.connecting        = ${socket.connecting}`);

      console.log('\n[SMDR-DEBUG] 📋 STEP 2: PBX Identification');
      console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
      const remote = `${socket.remoteAddress}:${socket.remotePort}`;
      console.log(`[SMDR-DEBUG]   Remote endpoint          = ${remote}`);
      console.log(`[SMDR-DEBUG]   Expected PBX_HOST        = ${PBX_HOST}`);
      
      const isPBX = socket.remoteAddress === PBX_HOST ||
        socket.remoteAddress === `::ffff:${PBX_HOST}`;
      
      console.log(`[SMDR-DEBUG]   Direct match?            = ${socket.remoteAddress === PBX_HOST}`);
      console.log(`[SMDR-DEBUG]   IPv6-mapped match?       = ${socket.remoteAddress === `::ffff:${PBX_HOST}`}`);
      console.log(`[SMDR-DEBUG]   Is PBX?                  = ${isPBX ? '✅ YES' : '❌ NO'}`);
      
      if (!isPBX) {
        console.warn(`[SMDR-DEBUG] ⚠️  UNEXPECTED SOURCE: Connection from ${socket.remoteAddress}`);
        console.warn(`[SMDR-DEBUG]    Expected: ${PBX_HOST}`);
        console.warn('[SMDR-DEBUG]    Possible causes:');
        console.warn('[SMDR-DEBUG]      1. PBX_HOST in .env is incorrect');
        console.warn('[SMDR-DEBUG]      2. PBX is configured to send to wrong IP');
        console.warn('[SMDR-DEBUG]      3. Network routing issue');
      }

      // Prevent multiple PBX sockets
      if (global.activePbxSocket) {
        console.log('\n[SMDR-DEBUG] 📋 STEP 3: Active Socket Management');
        console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
        console.log('[SMDR-DEBUG] ⚠️  Previous PBX socket exists, closing it...');
        try {
          global.activePbxSocket.destroy();
          console.log('[SMDR-DEBUG] ✅ Previous socket destroyed');
        } catch (e) {
          console.error('[SMDR-DEBUG] ❌ Error destroying previous socket:', e.message);
        }
        connectedPeers = 0;
      }

      global.activePbxSocket = socket;
      connectedPeers = 1;
      isConnected = true;

      console.log('\n[SMDR-DEBUG] 📋 STEP 4: Connection State Update');
      console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
      console.log(`[SMDR-DEBUG]   global.activePbxSocket   = SET`);
      console.log(`[SMDR-DEBUG]   connectedPeers           = ${connectedPeers}`);
      console.log(`[SMDR-DEBUG]   isConnected              = ${isConnected}`);

      console.log('[SMDR-DEBUG] TCP session accepted; emitting pbx:connected before any call data.');
      emit('pbx:connected', {
        ip: socket.remoteAddress,
        port: socket.remotePort,
        connectedAt: Date.now(),
        mode: 'server',
        isPBX: isPBX,
        protocol: 'tcp-accepted'
      });

      // ── OG HANDSHAKING PROTOCOL ──────────────────────────────────────────
      let handshakeComplete = false;
      const handshakeTimeout = setTimeout(() => {
        if (!handshakeComplete) {
          console.warn(`\n[SMDR-DEBUG] ⏱️  HANDSHAKE TIMEOUT from ${remote}`);
          console.warn('[SMDR-DEBUG]    No ENQ (0x00) received within 5 seconds');
          console.warn('[SMDR-DEBUG]    Possible causes:');
          console.warn('[SMDR-DEBUG]      1. PBX SMDR service not fully started');
          console.warn('[SMDR-DEBUG]      2. PBX sending SMDR Report instead of SMDR Online');
          console.warn('[SMDR-DEBUG]      3. PBX configuration mismatch');
          console.warn('[SMDR-DEBUG]    Keeping socket open instead of destroying it; waiting for call data.');
        }
      }, 5000);

      console.log('\n[SMDR-DEBUG] 📋 STEP 5: Handshake Protocol Setup');
      console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
      console.log('[SMDR-DEBUG] Waiting for ENQ (0x00) handshake from PBX...');
      console.log('[SMDR-DEBUG] Idle sockets are kept open; no forced handshake disconnect.');

      socket.on('data', (data) => {
        console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
        console.log('[SMDR-DEBUG] ║ DATA RECEIVED — DETAILED ANALYSIS                      ║');
        console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

        console.log('[SMDR-DEBUG] 📋 STEP 1: Raw Data Inspection');
        console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
        console.log(`[SMDR-DEBUG]   Bytes received           = ${data.length}`);
        console.log(`[SMDR-DEBUG]   Data type                = ${data.constructor.name}`);
        console.log(`[SMDR-DEBUG]   Hex dump                 = ${data.toString('hex')}`);
        console.log(`[SMDR-DEBUG]   ASCII dump               = ${JSON.stringify(data.toString('utf8'))}`);
        console.log(`[SMDR-DEBUG]   First byte (decimal)     = ${data.length > 0 ? data[0] : 'N/A'}`);
        console.log(`[SMDR-DEBUG]   First byte (hex)         = ${data.length > 0 ? '0x' + data[0].toString(16).padStart(2, '0') : 'N/A'}`);

        // If handshake not complete, check for ENQ
        if (!handshakeComplete) {
          console.log('\n[SMDR-DEBUG] 📋 STEP 2: Handshake Phase Analysis');
          console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
          console.log('[SMDR-DEBUG] Handshake status: NOT COMPLETE');
          
          // Check if this is ENQ (0x00) character
          if (data.length > 0 && data[0] === MATRIX_ENQ) {
            console.log('[SMDR-DEBUG] ✅ ENQ (0x00) DETECTED — Handshake initiated!');
            
            // Send ACK (0x06) to acknowledge
            console.log('[SMDR-DEBUG] 📤 Sending ACK (0x06) response...');
            safelyAckMatrixPacket(socket, 'ENQ handshake');
            
            handshakeComplete = true;
            clearTimeout(handshakeTimeout);

            console.log('\n[SMDR-DEBUG] 📋 STEP 3: Handshake Complete — Emitting pbx:connected');
            console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
            console.log('[SMDR-DEBUG] ✅ Emitting pbx:connected event');
            console.log(`[SMDR-DEBUG]   IP: ${socket.remoteAddress}`);
            console.log(`[SMDR-DEBUG]   Port: ${socket.remotePort}`);
            console.log('[SMDR-DEBUG]   Protocol: OG-Handshaking');
            
            emit('pbx:connected', { 
              ip: socket.remoteAddress, 
              port: socket.remotePort, 
              connectedAt: Date.now(),
              mode: 'server',
              isPBX: isPBX,
              protocol: 'OG-Handshaking'
            });
            return; // Don't process this as data
          } else {
            console.warn('[SMDR-DEBUG] ⚠️  UNEXPECTED DATA — Expected ENQ (0x00)');
            console.warn(`[SMDR-DEBUG]    Received: ${JSON.stringify(data.toString('utf8'))}`);
            console.warn('[SMDR-DEBUG]    Hex: ' + data.toString('hex'));
            console.warn('[SMDR-DEBUG]    Possible causes:');
            console.warn('[SMDR-DEBUG]      1. PBX sending SMDR Report (historical) instead of SMDR Online (real-time)');
            console.warn('[SMDR-DEBUG]      2. PBX SMDR service not fully initialized');
            console.warn('[SMDR-DEBUG]      3. PBX configuration mismatch');
            console.warn('[SMDR-DEBUG]    FIX: Restart SMDR service on PBX (System → Services → SMDR)');
            
            handshakeComplete = true; // Assume no handshaking required
            clearTimeout(handshakeTimeout);
            
            console.log('[SMDR-DEBUG] ✅ Treating as raw-tcp protocol (no handshaking)');
            console.log('[SMDR-DEBUG] ✅ Emitting pbx:connected event');
            
            emit('pbx:connected', { 
              ip: socket.remoteAddress, 
              port: socket.remotePort, 
              connectedAt: Date.now(),
              mode: 'server',
              isPBX: isPBX,
              protocol: 'raw-tcp'
            });
          }
        }

        // Process data (after handshake or if no handshaking)
        console.log('\n[SMDR-DEBUG] 📋 STEP 4: Data Processing');
        console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
        console.log('[SMDR-DEBUG] Handshake status: COMPLETE');
        console.log('[SMDR-DEBUG] Processing SMDR records...');

        const hasPacketFrame = data.includes(MATRIX_STX) || data.includes(MATRIX_ETX);
        let raw = data.toString('utf8')
          .replace(/\x02/g, '')
          .replace(/\x03/g, '')
          .replace(/\x00/g, '')
          .replace(/[^\x20-\x7E\r\n]/g, '');

        console.log(`[SMDR-DEBUG]   Cleaned data: ${JSON.stringify(raw)}`);
        console.log(`[SMDR-DEBUG]   Cleaned length: ${raw.length} bytes`);

        if (!raw.trim()) {
          console.log('[SMDR-DEBUG] ℹ️  No data after cleaning, skipping...');
          return;
        }

        lastActivityTime = new Date();
        buffer += raw;
        console.log(`[SMDR-DEBUG]   Buffer size: ${buffer.length} bytes`);

        processBuffer();
        if (hasPacketFrame) {
          safelyAckMatrixPacket(socket, 'SMDR data packet');
        }
      });

      socket.on('close', (hadError) => {
        console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
        console.log('[SMDR-DEBUG] ║ SOCKET CLOSED — DETAILED TRACE                         ║');
        console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

        console.log('[SMDR-DEBUG] 📋 STEP 1: Close Event Analysis');
        console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
        console.log(`[SMDR-DEBUG]   Remote endpoint          = ${remote}`);
        console.log(`[SMDR-DEBUG]   Had error?               = ${hadError}`);
        console.log(`[SMDR-DEBUG]   Buffer cleared           = YES`);

        buffer = '';
        connectedPeers = Math.max(0, connectedPeers - 1);
        isConnected = connectedPeers > 0 || (smdrClient && !smdrClient.destroyed);

        console.log('\n[SMDR-DEBUG] 📋 STEP 2: Connection State Update');
        console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
        console.log(`[SMDR-DEBUG]   connectedPeers (after)   = ${connectedPeers}`);
        console.log(`[SMDR-DEBUG]   isConnected (after)      = ${isConnected}`);
        console.log(`[SMDR-DEBUG]   Reason                   = ${hadError ? 'Socket error' : 'Peer disconnected'}`);

        console.log('\n[SMDR-DEBUG] 📋 STEP 3: Emitting pbx:disconnected');
        console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
        
        emit('pbx:disconnected', { 
          disconnectedAt: Date.now(),
          reason: hadError ? 'Socket error' : 'Peer disconnected',
          peers: connectedPeers,
          fatal: false
        });
      });

      socket.on('error', (err) => {
        console.error('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
        console.error('[SMDR-DEBUG] ║ SOCKET ERROR — DETAILED TRACE                          ║');
        console.error('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

        console.error('[SMDR-DEBUG] 📋 STEP 1: Error Details');
        console.error('[SMDR-DEBUG] ─────────────────────────────────────────────────');
        console.error(`[SMDR-DEBUG]   Remote endpoint          = ${remote}`);
        console.error(`[SMDR-DEBUG]   Error message            = ${err.message}`);
        console.error(`[SMDR-DEBUG]   Error code               = ${err.code}`);
        console.error(`[SMDR-DEBUG]   Error stack              = ${err.stack}`);

        emit('pbx:binding_error', {
          service: 'matrixSmdr',
          mode: 'server_socket',
          error: err.message,
          code: err.code,
          remote: remote
        });
      });
    });
    console.log('[SMDR-DEBUG] ✅ net.createServer() created successfully');
  } catch (err) {
    console.error('[SMDR-DEBUG] ❌ Error creating server:', err.message);
    throw err;
  }

  console.log('\n[SMDR-DEBUG] 📋 STEP 3: Binding Server to Port');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  console.log(`[SMDR-DEBUG]   Binding to: 0.0.0.0:${SMDR_PORT}`);

  tcpServer.listen(SMDR_PORT, '0.0.0.0', () => {
    console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
    console.log('[SMDR-DEBUG] ║ SERVER LISTENING — READY FOR CONNECTIONS               ║');
    console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

    console.log('[SMDR-DEBUG] 📋 STEP 1: Server Binding Successful');
    console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
    console.log(`[SMDR-DEBUG]   ✅ Listening on 0.0.0.0:${SMDR_PORT}`);
    console.log(`[SMDR-DEBUG]   Waiting for Matrix PBX (${PBX_HOST}) to initiate TCP handshake...`);
    console.log('[SMDR-DEBUG]   Expected handshake: ENQ (0x00) → ACK (0x06)');
    console.log('[SMDR-DEBUG]   Expected data format: STX (0x02) + SMDR Records + ETX (0x03)');

    emit('pbx:listening', { mode: 'server', port: SMDR_PORT, connectedAt: Date.now() });
  });

  // Heartbeat to keep logs moving and show service is alive
  if (global.smdrHeartbeat) clearInterval(global.smdrHeartbeat);
  global.smdrHeartbeat = setInterval(() => {
    if (connectedPeers === 0) {
      console.log(`[SMDR-DEBUG] 💓 Heartbeat: Listening on port ${SMDR_PORT}... (No active PBX connection yet)`);
    } else {
      console.log(`[SMDR-DEBUG] 💓 Heartbeat: Active connection maintained. (Peers: ${connectedPeers})`);
    }
  }, 60000);

  tcpServer.on('error', (err) => {
    console.error('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
    console.error('[SMDR-DEBUG] ║ SERVER ERROR — DETAILED TRACE                          ║');
    console.error('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

    console.error('[SMDR-DEBUG] 📋 STEP 1: Server Error Details');
    console.error('[SMDR-DEBUG] ─────────────────────────────────────────────────');
    console.error(`[SMDR-DEBUG]   Error message            = ${err.message}`);
    console.error(`[SMDR-DEBUG]   Error code               = ${err.code}`);
    console.error(`[SMDR-DEBUG]   Error stack              = ${err.stack}`);

    if (err.code === 'EADDRINUSE') {
      console.error(`[SMDR-DEBUG] ❌ Port ${SMDR_PORT} is already in use!`);
      console.error('[SMDR-DEBUG]    Possible causes:');
      console.error('[SMDR-DEBUG]      1. Another instance of this service is running');
      console.error('[SMDR-DEBUG]      2. Previous process did not clean up properly');
      console.error('[SMDR-DEBUG]      3. Another application is using this port');
      console.error('[SMDR-DEBUG]    FIX: Kill the process using this port or change SMDR_PORT');
    } else if (err.code === 'EACCES') {
      console.error(`[SMDR-DEBUG] ❌ Permission denied for port ${SMDR_PORT}!`);
      console.error('[SMDR-DEBUG]    Ports < 1024 require elevated privileges');
    }

    emit('pbx:disconnected', {
      service: 'matrixSmdr',
      mode: 'server',
      fatal: true,
      error: err.message,
      code: err.code,
      port: SMDR_PORT
    });

    console.log('[SMDR-DEBUG] 📋 STEP 2: Retry Schedule');
    console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
    console.log('[SMDR-DEBUG] Retrying server in 30 seconds...');
    setTimeout(startServer, 30000);
  });
}

function getStatus() {
  const now = Date.now();
  const lastActivityAgeSeconds = lastActivityTime
    ? Math.round((now - lastActivityTime.getTime()) / 1000)
    : null;
  const streamFreshSeconds = parseInt(process.env.SMDR_STALE_AFTER_SECONDS || '300', 10);
  const dataStreamHealthy = isConnected &&
    lastActivityAgeSeconds !== null &&
    lastActivityAgeSeconds <= streamFreshSeconds;
  const status = {
    connected: isConnected,
    host: PBX_HOST,
    port: SMDR_PORT,
    ctiPort: CTI_PORT,
    peers: connectedPeers,
    listening: isListening(),
    mode: 'server',
    lastActivity: lastActivityTime ? lastActivityTime.toISOString() : null,
    lastActivityAgeSeconds,
    dataStreamHealthy,
    staleAfterSeconds: streamFreshSeconds,
    savedCallCount,
    parseFailureCount,
    activeSocket: !!global.activePbxSocket && !global.activePbxSocket.destroyed,
    activeSocketRemote: global.activePbxSocket && !global.activePbxSocket.destroyed
      ? `${global.activePbxSocket.remoteAddress}:${global.activePbxSocket.remotePort}`
      : null,
    serverAddress: tcpServer && tcpServer.listening ? tcpServer.address() : null,
    outboundClientActive: !!smdrClient && !smdrClient.destroyed,
    timestamp: new Date().toISOString(),
  };
  console.log('[SMDR-STATUS] getStatus snapshot:', status);
  return status;
}

async function start() {
  console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
  console.log('[SMDR-DEBUG] ║ SMDR SERVICE START — INITIALIZATION SEQUENCE            ║');
  console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');

  console.log('[SMDR-DEBUG] 📋 STEP 1: Database Table Initialization');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  try {
    await ensureTable();
    console.log('[SMDR-DEBUG] ✅ Database table ready');
  } catch (err) {
    console.error('[SMDR-DEBUG] ❌ Database initialization failed:', err.message);
    throw err;
  }

  console.log('\n[SMDR-DEBUG] 📋 STEP 2: TCP Server Startup');
  console.log('[SMDR-DEBUG] ─────────────────────────────────────────────────');
  console.log('[SMDR-DEBUG] Starting TCP server in passive mode (PBX connects to us)...');
  startServer();
  console.log('[SMDR-DEBUG] ✅ TCP server startup initiated');

  console.log('\n[SMDR-DEBUG] ╔════════════════════════════════════════════════════════╗');
  console.log('[SMDR-DEBUG] ║ SMDR SERVICE READY — WAITING FOR PBX CONNECTION         ║');
  console.log('[SMDR-DEBUG] ╚════════════════════════════════════════════════════════╝\n');
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

// Status helper functions
function isListening() {
  return tcpServer !== null && tcpServer.listening;
}

function getConnectedPeers() {
  return connectedPeers;
}

function getLastActivity() {
  return lastActivityTime || null;
}

module.exports = { start, setIO, getStatus, dial, reconnect, isListening, getConnectedPeers, getLastActivity };
