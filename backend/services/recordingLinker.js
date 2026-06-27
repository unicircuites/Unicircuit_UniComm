const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');

let LOCAL_STORED_DIR = process.env.PBX_LOCAL_RECORDINGS_DIR || 'D:\\Unicomm_Storage';
if (process.platform === 'win32' && !fs.existsSync('D:\\') && LOCAL_STORED_DIR.startsWith('D:')) {
  LOCAL_STORED_DIR = path.join(__dirname, '..', 'pbx_recordings');
}
const TIMESTAMP_TOLERANCE_MS = parseInt(process.env.PBX_RECORDING_MATCH_TOLERANCE_MS || '1200000', 10); // 20 min default (date must still match exactly)
const AUDIO_EXT_RE = /\.(wav|mp3|ogg|m4a)$/i;

/**
 * Scans directories recursively for audio files
 */
function getAllRecordingFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      const skipFolders = ['_BACKUPS', '_BACK', 'BACKUP', 'BACKUPS'];
      if (skipFolders.some(name => item.name.toUpperCase().includes(name))) {
        continue;
      }
      results = results.concat(getAllRecordingFiles(fullPath));
    } else {
      const ext = path.extname(item.name).toLowerCase();
      if (['.wav', '.mp3', '.ogg', '.m4a'].includes(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Normalizes a phone number for matching.
 * Keeps only digits, and takes the last 10 digits to handle
 * varying country codes (e.g. +91, 0, etc).
 */
function normalizePhone(str) {
  if (!str) return '';
  const digits = String(str).replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);

  const match = String(str).match(/\d+/);
  return match ? match[0] : '';
}

function isPlayableRecordingPath(value) {
  return !!(value && AUDIO_EXT_RE.test(String(value).trim()));
}

function parseDurationToMs(durStr) {
  if (!durStr) return 0;
  durStr = String(durStr).trim();
  if (durStr.includes(':')) {
    const parts = durStr.split(':').map(Number);
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }
  let seconds = 0;
  const mMatch = durStr.match(/(\d+)\s*m/i);
  if (mMatch) seconds += parseInt(mMatch[1], 10) * 60;
  const sMatch = durStr.match(/(\d+)\s*s/i);
  if (sMatch) seconds += parseInt(sMatch[1], 10);
  return seconds * 1000;
}

/**
 * Parses Matrix recording filenames (CT/LM).
 * Supports both CT_<phone>_<ext> and CT_<ext>_<phone> — short numeric token = extension.
 */
function parseRecordingFilename(filename) {
  const baseName = path.basename(filename);
  const clean = baseName.replace(/\.[^.]+$/, '');
  const parts = clean.split('_');

  const dateIndex = parts.findIndex((part, index) =>
    /^\d{8}$/.test(part || '') && /^\d{6}$/.test(parts[index + 1] || '')
  );
  if (dateIndex < 0) return null;

  const datePart = parts[dateIndex];
  const timePart = parts[dateIndex + 1];
  const day = datePart.substring(0, 2);
  const month = datePart.substring(2, 4);
  const year = datePart.substring(4, 8);
  const hour = timePart.substring(0, 2);
  const minute = timePart.substring(2, 4);
  const second = timePart.substring(4, 6);
  const timestamp = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
  if (Number.isNaN(timestamp.getTime())) return null;

  let extension = '';
  let phone = '';
  const remaining = parts.filter((part, index) =>
    part &&
    !/^(CT|LM)$/i.test(part) &&
    index !== dateIndex &&
    index !== dateIndex + 1
  );

  for (const part of remaining) {
    const digits = String(part).replace(/\D/g, '');
    if (/^\d{1,5}$/.test(digits) && digits === String(part).replace(/\D/g, '')) {
      if (!extension) extension = digits;
      else if (!phone && digits.length >= 6) phone = normalizePhone(part);
    } else if (digits.length >= 6) {
      phone = normalizePhone(part);
    }
  }

  if (!extension || !phone) return null;

  return {
    filename: baseName,
    timestamp,
    timestampMs: timestamp.getTime(),
    extension: normalizePhone(extension),
    phone,
    rawPhone: phone
  };
}

function indexKey(phone, extension) {
  return `${phone}|${extension}`;
}

function phoneOnlyKey(phone) {
  return `phone:${phone}`;
}

function addToIndex(index, phone, extension, entry) {
  if (!phone || !extension) return;
  const key = indexKey(phone, extension);
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(entry);
}

function buildRecordingIndex(entries) {
  const index = new Map();
  for (const entry of entries) {
    addToIndex(index, entry.phone, entry.extension, entry);
    addToIndex(index, entry.phone, '*', entry);
    // Also index by phone only — for forwarded calls where extension changes mid-call
    const pk = phoneOnlyKey(entry.phone);
    if (!index.has(pk)) index.set(pk, []);
    index.get(pk).push(entry);
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.timestampMs - b.timestampMs);
  }
  return index;
}

function formatCallDateValue(callDate) {
  if (!callDate) return '';
  if (callDate instanceof Date) {
    const y = callDate.getFullYear();
    const m = String(callDate.getMonth() + 1).padStart(2, '0');
    const day = String(callDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return String(callDate).split('T')[0];
}

function getCallTimestamps(call) {
  let callEndMs = 0;
  const callDateValue = call.call_date_value || call.call_date;
  if (callDateValue && call.call_time) {
    const d = formatCallDateValue(callDateValue);
    const time = String(call.call_time).split('.')[0];
    const obj = new Date(`${d}T${time}`);
    if (!Number.isNaN(obj.getTime())) callEndMs = obj.getTime();
  } else if (call.created_at) {
    callEndMs = new Date(call.created_at).getTime();
  }
  if (!callEndMs) return null;

  const durationMs = parseDurationToMs(call.duration);
  // For forwarded calls, the call_time stored is the answer time of the final hop.
  // The recording is stamped at the very beginning of the original call.
  // Use a generous start: callEndMs minus duration minus TOLERANCE to catch recordings
  // that started before the forwarded leg was answered.
  return {
    callStartMs: callEndMs - durationMs - TIMESTAMP_TOLERANCE_MS,
    callEndMs: callEndMs + TIMESTAMP_TOLERANCE_MS
  };
}

function getCallMatchKeys(call) {
  const phones = new Set();
  const extensions = new Set();

  for (const field of [call.caller, call.destination, call.extension]) {
    // extension may be a multi-hop chain like "21 | 202" — split and consider each hop
    for (const piece of String(field || '').split('|')) {
      const raw = piece.trim();
      if (!raw) continue;
      const digits = raw.replace(/\D/g, '');
      if (digits.length >= 10) {
        phones.add(normalizePhone(raw));
      } else {
        const short = normalizePhone(raw);
        if (short) extensions.add(short);
      }
    }
  }

  return { phones: [...phones], extensions: [...extensions] };
}

// Local (not UTC) YYYY-MM-DD for a timestamp — recording timestamps and call times are
// both built as local Date objects, so date comparison must use local components too.
function localDateStr(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function timestampMatches(recMs, callStartMs, callEndMs, callDateStr) {
  const POSSIBLE_SKEWS_MS = [
    0,
    7 * 24 * 60 * 60 * 1000,  // 7 days slow (PBX clock is 7 days behind)
    -7 * 24 * 60 * 60 * 1000  // 7 days fast (PBX clock is 7 days ahead)
  ];

  for (const skew of POSSIBLE_SKEWS_MS) {
    const adjustedRecMs = recMs + skew;
    if (adjustedRecMs < callStartMs || adjustedRecMs > callEndMs) continue;
    // Date must match EXACTLY — a recording on a different calendar day is never the same
    // call, even if it falls inside the time tolerance window (e.g. just after midnight).
    if (callDateStr && localDateStr(adjustedRecMs) !== callDateStr) continue;
    return { inWindow: true, skew, adjustedRecMs };
  }
  return null;
}

function findBestMatch(call, index, usedPaths) {
  const times = getCallTimestamps(call);
  if (!times) return null;

  const { phones, extensions } = getCallMatchKeys(call);
  if (!phones.length) return null;

  // Reconstruct the bare call window (without tolerance) for proximity scoring
  const callDateValue = call.call_date_value || call.call_date;
  // Exact calendar date the call happened on — recordings must share this date.
  const callDateStr = formatCallDateValue(callDateValue)
    || (call.created_at ? localDateStr(new Date(call.created_at).getTime()) : '');
  let bareCallEndMs = 0;
  if (callDateValue && call.call_time) {
    const d = formatCallDateValue(callDateValue);
    const time = String(call.call_time).split('.')[0];
    const obj = new Date(`${d}T${time}`);
    if (!Number.isNaN(obj.getTime())) bareCallEndMs = obj.getTime();
  } else if (call.created_at) {
    bareCallEndMs = new Date(call.created_at).getTime();
  }
  const durationMs = parseDurationToMs(call.duration);
  const bareCallStartMs = bareCallEndMs - durationMs;

  let bestMatch = null;
  let bestScore = Infinity;

  for (const phone of phones) {
    const extensionKeys = extensions.length ? [...extensions, '*'] : ['*'];
    const candidateSets = [
      ...extensionKeys.map((ext, i) => ({ candidates: index.get(indexKey(phone, ext)) || [], penalty: i === 0 ? 0 : 1000 })),
      { candidates: index.get(phoneOnlyKey(phone)) || [], penalty: 2000 }
    ];

    for (const { candidates, penalty } of candidateSets) {
      for (const rec of candidates) {
        if (usedPaths.has(rec.playbackPath)) continue;

        const matchInfo = timestampMatches(rec.timestampMs, times.callStartMs, times.callEndMs, callDateStr);
        if (matchInfo === null) continue;

        // Use proximity to bare call start as tiebreaker (closer = better)
        // Direct matches are heavily preferred over skewed matches by adding a skew penalty.
        const proximity = Math.abs(matchInfo.adjustedRecMs - bareCallStartMs);
        const skewPenalty = matchInfo.skew === 0 ? 0 : 5000000;
        const score = proximity + penalty + skewPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestMatch = rec;
        }
      }
    }
  }

  return bestMatch;
}

async function loadStoredRecordingEntries() {
  const entries = [];
  const { rows } = await pool.query(`
    SELECT original_filename, local_path, extension_number, customer_number, recording_date, extension_folder
    FROM pbx_recordings
    WHERE local_path IS NOT NULL AND local_path <> ''
    ORDER BY recording_date DESC NULLS LAST, id DESC
  `);

  for (const row of rows) {
    const parsed = parseRecordingFilename(row.original_filename || row.local_path);
    const phone = normalizePhone(row.customer_number) || parsed?.phone;
    const extension = normalizePhone(row.extension_number) || parsed?.extension;
    const timestampMs = parsed?.timestampMs || (row.recording_date
      ? new Date(row.recording_date).getTime()
      : null);

    if (!phone || !extension || !timestampMs || Number.isNaN(timestampMs)) continue;
    if (!fs.existsSync(row.local_path)) continue;

    const rel = path.relative(LOCAL_STORED_DIR, row.local_path).replace(/\\/g, '/');
    // Recordings stored in the common mailbox folder (e.g. 221) cover ALL calls
    // regardless of which extension answered — mark as shareable so multiple call
    // log rows (390 row + forwarded extension row) can both link to the same file.
    const isCommonMailbox = String(row.extension_folder || '').startsWith('221');
    entries.push({
      phone,
      extension,
      timestampMs,
      playbackPath: rel,
      source: 'db',
      shareable: isCommonMailbox
    });
  }

  return entries;
}

function loadFilesystemRecordingEntries(recordingsDir) {
  const entries = [];
  if (!recordingsDir || !fs.existsSync(recordingsDir)) return entries;

  for (const file of getAllRecordingFiles(recordingsDir)) {
    const parsed = parseRecordingFilename(file);
    if (!parsed) continue;

    entries.push({
      phone: parsed.phone,
      extension: parsed.extension,
      timestampMs: parsed.timestampMs,
      playbackPath: path.relative(recordingsDir, file).replace(/\\/g, '/'),
      source: 'fs'
    });
  }

  return entries;
}

/**
 * Main linking function.
 * Matches unlinked call logs with stored PBX recordings (DB + optional network folder).
 */
async function linkRecordingsToCallLogs(recordingsDir) {
  try {
    console.log('[Linker] Starting recording linking process...');

    const { rows: candidateCalls } = await pool.query(`
      SELECT id, TO_CHAR(call_date, 'YYYY-MM-DD') AS call_date_value,
             call_date, call_time, duration, created_at, caller, destination, extension, call_type, recording_file
      FROM call_logs
    `);
    const unlinkedCalls = candidateCalls.filter(call =>
      !isPlayableRecordingPath(call.recording_file) ||
      !resolveRecordingFullPath(call.recording_file, recordingsDir)
    );

    if (!unlinkedCalls.length) {
      console.log('[Linker] No unlinked call logs found. Exiting.');
      return { success: true, matchedCount: 0, message: 'No unlinked calls found' };
    }

    console.log(`[Linker] Found ${unlinkedCalls.length} call logs needing recording links or stale path repair.`);

    const storedEntries = await loadStoredRecordingEntries();
    const fsEntries = loadFilesystemRecordingEntries(recordingsDir);
    const allEntries = [...storedEntries, ...fsEntries];

    console.log(`[Linker] Indexed ${storedEntries.length} stored DB recordings, ${fsEntries.length} network files.`);

    if (!allEntries.length) {
      return {
        success: false,
        matchedCount: 0,
        message: 'No playable recordings found in database or PBX_RECORDINGS_DIR'
      };
    }

    // Build set of shareable paths (common mailbox) — never block these
    const shareablePaths = new Set(
      allEntries.filter(e => e.shareable).map(e => e.playbackPath)
    );

    const index = buildRecordingIndex(allEntries);
    const usedPaths = new Set();

    // Only mark recordings as "used" by rows that are NOT in the unlinked set.
    // Forwarded/transferred calls generate multiple SMDR rows; the intermediate hop
    // may already hold a recording_file that the merged/final row also needs.
    // Excluding unlinked rows from usedPaths lets them compete for those recordings.
    const unlinkedIds = new Set(unlinkedCalls.map(c => c.id));
    const alreadyLinked = await pool.query(`
      SELECT id, recording_file FROM call_logs
      WHERE recording_file IS NOT NULL AND recording_file <> ''
        AND recording_file ~* '\\.(wav|mp3|ogg|m4a)$'
    `);
    for (const row of alreadyLinked.rows) {
      if (unlinkedIds.has(row.id)) continue; // will be re-evaluated
      const p = String(row.recording_file).replace(/\\/g, '/');
      if (shareablePaths.has(p)) continue; // common mailbox — always shareable
      if (resolveRecordingFullPath(row.recording_file, recordingsDir)) {
        usedPaths.add(p);
      }
    }

    let matchedCount = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const call of unlinkedCalls) {
        const bestMatch = findBestMatch(call, index, usedPaths);
        if (!bestMatch) continue;

        await client.query(
          `UPDATE call_logs SET recording_file = $1 WHERE id = $2`,
          [bestMatch.playbackPath, call.id]
        );
        // Only mark as used if not from the common mailbox — common mailbox recordings
        // can link to multiple rows (e.g. both the 390 row and the forwarded ext row)
        if (!bestMatch.shareable) usedPaths.add(bestMatch.playbackPath);
        matchedCount++;
      }

      await client.query('COMMIT');
      console.log(`[Linker] Successfully linked ${matchedCount} recordings to call logs.`);
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    return {
      success: true,
      matchedCount,
      message: `Successfully linked ${matchedCount} recordings (${storedEntries.length} indexed from DB)`
    };
  } catch (err) {
    console.error('[Linker] Error linking recordings:', err.message);
    return { success: false, error: err.message, matchedCount: 0 };
  }
}

/**
 * Resolve a recording path for streaming (network share or local PBX store).
 */
function resolveRecordingFullPath(fileParam, recordingsDir) {
  if (!fileParam) return null;

  const normalized = String(fileParam).replace(/\\/g, '/');
  const roots = [
    { base: path.resolve(recordingsDir || ''), file: normalized },
    { base: path.resolve(LOCAL_STORED_DIR), file: normalized }
  ];

  if (path.isAbsolute(fileParam)) {
    roots.push({ base: '', file: path.resolve(fileParam) });
  }

  for (const { base, file } of roots) {
    const fullPath = base ? path.resolve(base, file) : file;
    const safeBase = base || path.dirname(fullPath);
    if (base && !fullPath.startsWith(safeBase)) continue;
    if (fs.existsSync(fullPath)) return fullPath;
  }

  return null;
}

module.exports = {
  linkRecordingsToCallLogs,
  parseRecordingFilename,
  normalizePhone,
  isPlayableRecordingPath,
  resolveRecordingFullPath,
  LOCAL_STORED_DIR
};
