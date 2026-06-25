/**
 * Backfill: remove VMS pilot (390) from call_logs.extension, rebuild the real
 * multi-hop extension chain ("21 | 202") from sibling legs, and copy the answered
 * leg's recording onto the former-VMS leg so a recording shows side-by-side.
 *
 * Matching rule (per request): SAME calendar date exactly; call_time within 20 min
 * (not 1 hour). Then refresh the deduped view and re-run the recording linker.
 *
 * Safe to re-run (idempotent). Use --dry to preview without writing.
 */
const pool = require('../db/pool');
const path = require('path');
const { linkRecordingsToCallLogs } = require('../services/recordingLinker');

const DRY = process.argv.includes('--dry');
const WINDOW_MS = 20 * 60 * 1000; // 20 minutes
const AUDIO_RE = /\.(wav|mp3|ogg|m4a)$/i;
const VMS = new Set((process.env.VMS_EXTENSIONS || '390').split(',').map(s => s.trim()).filter(Boolean));

const isVms = (v) => VMS.has(String(v || '').trim());
const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// Only emit extensions that are KNOWN real answering extensions (recording-backed).
// This excludes VMS pilots (390) and legacy parse-garbage fragments (3, 52, 23, …).
function buildChain(knownExts, ...vals) {
  const seen = new Set(), out = [];
  for (const v of vals) {
    for (const piece of String(v || '').split('|')) {
      const e = piece.trim();
      if (!/^\d{2,5}$/.test(e) || isVms(e) || !knownExts.has(e)) continue;
      if (!seen.has(e)) { seen.add(e); out.push(e); }
    }
  }
  return out;
}

function ms(dateStr, timeStr) {
  const t = String(timeStr || '00:00:00').split('.')[0];
  const d = new Date(`${dateStr}T${t}`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

(async () => {
  // Authoritative set of real answering extensions = those that own recordings.
  const ke = await pool.query(`SELECT DISTINCT extension_number FROM pbx_recordings WHERE extension_number ~ $1`, ['^[0-9]{2,5}$']);
  const knownExts = new Set(ke.rows.map(r => String(r.extension_number).trim()).filter(e => !isVms(e)));
  console.log(`Known real extensions (recording-backed): ${[...knownExts].sort().join(', ')}`);

  const { rows } = await pool.query(`
    SELECT id, TO_CHAR(call_date,'YYYY-MM-DD') AS d, call_time::text AS t,
           caller, destination, extension, recording_file, duration
    FROM call_logs
    WHERE call_type = 'In'
  `);
  console.log(`Loaded ${rows.length} incoming rows. VMS pilots: ${[...VMS].join(',')}. ${DRY ? '[DRY RUN]' : ''}`);

  // Group by caller(last10) + exact date
  const groups = new Map();
  for (const r of rows) {
    const key = `${last10(r.caller)}|${r.d}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const updates = []; // {id, extension, destination, recording_file}
  for (const list of groups.values()) {
    list.sort((a, b) => (ms(a.d, a.t) || 0) - (ms(b.d, b.t) || 0));
    for (const r of list) {
      const rMs = ms(r.d, r.t);
      if (rMs == null) continue;
      // sibling hops within ±20 min on the SAME date (group already same date)
      const win = list.filter(s => { const sMs = ms(s.d, s.t); return sMs != null && Math.abs(sMs - rMs) <= WINDOW_MS; });

      // nearest sibling recording (real-ext legs only carry recordings), for side-by-side
      let recCopy = null;
      const hasOwnRec = r.recording_file && AUDIO_RE.test(r.recording_file);
      if (!hasOwnRec) {
        const withRec = win
          .filter(s => s.recording_file && AUDIO_RE.test(s.recording_file))
          .sort((a, b) => Math.abs((ms(a.d, a.t) || 0) - rMs) - Math.abs((ms(b.d, b.t) || 0) - rMs));
        if (withRec.length) recCopy = withRec[0].recording_file;
      }

      // Only touch rows that are VMS-related (390 in ext/dest) or that gain a recording.
      // Leave unrelated/legacy-malformed rows untouched.
      const vmsRelated = isVms(r.extension) || isVms(r.destination);
      if (!vmsRelated && !recCopy) continue;

      // Chain of KNOWN real extensions seen across the call's hops (excludes 390 + garbage)
      const chain = buildChain(knownExts, ...win.flatMap(s => [s.extension, s.destination]));
      const chainStr = chain.length ? chain.join(' | ') : null;

      // extension: strip 390 → real chain, or null if no known real ext in window
      const newExt = isVms(r.extension) || !r.extension ? chainStr : r.extension;
      // destination: replace VMS pilot with the last real hop; otherwise leave as-is
      const newDest = isVms(r.destination) && chain.length ? chain[chain.length - 1] : r.destination;

      const extChanged = (r.extension || null) !== (newExt || null);
      const destChanged = (r.destination || null) !== (newDest || null);
      const recChanged = recCopy && recCopy !== r.recording_file;
      if (extChanged || destChanged || recChanged) {
        updates.push({ id: r.id, extension: newExt, destination: newDest, recording_file: recChanged ? recCopy : undefined });
      }
    }
  }

  // Stats
  const strip390 = updates.filter(u => isVms(rows.find(r => r.id === u.id).extension)).length;
  const recAttached = updates.filter(u => u.recording_file !== undefined).length;
  console.log(`Planned updates: ${updates.length} (strip-390 ext: ${strip390}, recordings copied: ${recAttached})`);
  console.log('Sample:', JSON.stringify(updates.slice(0, 8), null, 1));

  if (DRY) { await pool.end(); return; }

  const client = await pool.connect();
  let done = 0;
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      if (u.recording_file !== undefined) {
        await client.query(
          `UPDATE call_logs SET extension=$1, destination=$2, recording_file=$3 WHERE id=$4`,
          [u.extension, u.destination, u.recording_file, u.id]
        );
      } else {
        await client.query(
          `UPDATE call_logs SET extension=$1, destination=$2 WHERE id=$3`,
          [u.extension, u.destination, u.id]
        );
      }
      done++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(`Applied ${done} updates.`);

  // Re-run the linker for anything still unlinked, then refresh the deduped view.
  const REC_DIR = process.env.PBX_RECORDINGS_DIR || path.join(__dirname, '../../recordings');
  const linkRes = await linkRecordingsToCallLogs(REC_DIR);
  console.log('Linker:', JSON.stringify(linkRes));
  await pool.query('REFRESH MATERIALIZED VIEW call_logs_deduped').catch(e => console.warn('matview refresh:', e.message));

  // After stats
  const after = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE extension = '390')::int still_390_ext,
      COUNT(*) FILTER (WHERE destination='390' AND extension IS NOT NULL AND extension <> '' AND extension <> '390')::int vms_rows_with_real_ext
    FROM call_logs WHERE call_type='In'`);
  console.log('After:', JSON.stringify(after.rows[0]));

  await pool.end();
})().catch(async e => { console.error('FATAL', e); await pool.end().catch(() => {}); process.exit(1); });
