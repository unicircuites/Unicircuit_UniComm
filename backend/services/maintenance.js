const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Prunes the Antigravity conversation logs to prevent I/O latency.
 * Policy: 
 * 1. Remove files > 5MB
 * 2. Remove files older than 7 days
 * 3. Keep at least the 20 most recent files
 */
async function pruneAntigravityLogs() {
    const conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
    
    if (!fs.existsSync(conversationsDir)) {
        if (process.env.NODE_ENV !== 'production') {
            console.log('[Maintenance] Antigravity conversations directory not found. Skipping pruning.');
        }
        return;
    }

    try {
        const files = fs.readdirSync(conversationsDir)
            .filter(file => file.endsWith('.pb'))
            .map(file => {
                const filePath = path.join(conversationsDir, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    path: filePath,
                    size: stats.size,
                    mtime: stats.mtime
                };
            });

        // Sort by modification time (descending: newest first)
        files.sort((a, b) => b.mtime - a.mtime);

        const keepFiles = files.slice(0, 20);
        const candidateFiles = files.slice(20);

        let deletedCount = 0;
        let reclaimedBytes = 0;

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        for (const file of candidateFiles) {
            const isTooLarge = file.size > 5 * 1024 * 1024; // 5MB
            const isTooOld = file.mtime < sevenDaysAgo;

            if (isTooLarge || isTooOld) {
                fs.unlinkSync(file.path);
                deletedCount++;
                reclaimedBytes += file.size;
            }
        }

        if (deletedCount > 0) {
            console.log(`[Maintenance] Pruned ${deletedCount} legacy logs. Reclaimed ${(reclaimedBytes / (1024 * 1024)).toFixed(2)} MB.`);
        } else {
            console.log('[Maintenance] No Antigravity logs met the pruning criteria.');
        }
    } catch (err) {
        console.error('[Maintenance] Error pruning Antigravity logs:', err.message);
    }
}

/**
 * Reconciles call counts in the contacts table with actual records in call_logs.
 */
async function reconcileCallCounts(pool) {
  console.log('[Maintenance] Starting call count reconciliation...');
  try {
    const contactsRes = await pool.query('SELECT id, phone, wa, fname, lname FROM contacts');
    const contacts = contactsRes.rows;
    
    let totalUpdated = 0;

    for (const c of contacts) {
      const nums = [c.phone, c.wa].filter(n => n && n.length > 5).map(n => n.replace(/\s+/g, ''));
      if (nums.length === 0) continue;

      // Build conditions matching the contact's number as the EXTERNAL party only.
      // For Inbound: contact is the caller (external → internal).
      // For Outbound: contact is the destination (internal → external).
      // Forwarded hops have an internal extension (≤5 digits) as caller, so they are
      // excluded naturally — preventing double-counting forwarded call chains.
      const conditions = [];
      const params = [];
      let p = 1;

      nums.forEach(n => {
        const last10 = n.slice(-10);
        // Inbound: caller matches (external caller)
        conditions.push(`(call_type = 'In'  AND caller      LIKE $${p})`);
        params.push(`%${last10}`);
        p++;
        conditions.push(`(call_type = 'In'  AND caller      LIKE $${p})`);
        params.push(`%${n}%`);
        p++;
        // Outbound: destination matches (external destination)
        conditions.push(`(call_type = 'Out' AND destination LIKE $${p})`);
        params.push(`%${last10}`);
        p++;
        conditions.push(`(call_type = 'Out' AND destination LIKE $${p})`);
        params.push(`%${n}%`);
        p++;
      });

      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM call_logs WHERE ${conditions.join(' OR ')}`,
        params
      );

      const actualCount = countRes.rows[0].n;
      
      await pool.query(
        'UPDATE contacts SET calls = $1 WHERE id = $2',
        [actualCount, c.id]
      );
      totalUpdated++;
    }

    console.log(`[Maintenance] ✅ Reconciled call counts for ${totalUpdated} contacts.`);
    return totalUpdated;
  } catch (err) {
    console.error('[Maintenance] ❌ Reconciliation error:', err.message);
    throw err;
  }
}

/**
 * Normalizes VMS-pilot (e.g. 390) call legs in call_logs:
 *  - never leaves the VMS pilot in `extension` — replaces it with the real answering
 *    extension / multi-hop chain ("21 | 202"), or NULL when nothing real answered;
 *  - replaces a VMS-pilot `destination` with the last real hop;
 *  - copies the answered leg's recording onto the former-VMS leg so it shows side-by-side.
 * Matching: SAME calendar date exactly, call_time within 20 minutes. Idempotent.
 * Returns { updated, recCopied }.
 */
async function normalizeVmsExtensions(pool) {
  const VMS = new Set((process.env.VMS_EXTENSIONS || '390').split(',').map(s => s.trim()).filter(Boolean));
  const AUDIO_RE = /\.(wav|mp3|ogg|m4a)$/i;
  const WINDOW_MS = 20 * 60 * 1000;
  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  // Legacy rows can carry trailing date-digit junk ("390 14", "21 14"). Tokenise so the
  // leading token is the real value and VMS detection still works.
  const firstTok = (v) => (String(v || '').trim().split(/[\s|]+/)[0] || '');
  const isVms = (v) => VMS.has(firstTok(v));
  const hasJunk = (v) => /\s/.test(String(v || '').trim());
  const ms = (d, t) => {
    const time = String(t || '00:00:00').split('.')[0];
    const obj = new Date(`${d}T${time}`);
    return Number.isNaN(obj.getTime()) ? null : obj.getTime();
  };
  const buildChain = (knownExts, ...vals) => {
    const seen = new Set(), out = [];
    // split on whitespace AND pipe so "21 14" → ["21","14"] and only known real exts survive
    for (const v of vals) for (const piece of String(v || '').split(/[\s|]+/)) {
      const e = piece.trim();
      if (!/^\d{2,5}$/.test(e) || VMS.has(e) || !knownExts.has(e)) continue;
      if (!seen.has(e)) { seen.add(e); out.push(e); }
    }
    return out;
  };

  // Authoritative real-extension set = extensions that own recordings.
  const ke = await pool.query(`SELECT DISTINCT extension_number FROM pbx_recordings WHERE extension_number ~ $1`, ['^[0-9]{2,5}$']);
  const knownExts = new Set(ke.rows.map(r => String(r.extension_number).trim()).filter(e => !isVms(e)));

  const { rows } = await pool.query(`
    SELECT id, TO_CHAR(call_date,'YYYY-MM-DD') AS d, call_time::text AS t,
           caller, destination, extension, recording_file
    FROM call_logs WHERE call_type = 'In'`);

  const groups = new Map();
  for (const r of rows) {
    const key = `${last10(r.caller)}|${r.d}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const updates = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (ms(a.d, a.t) || 0) - (ms(b.d, b.t) || 0));
    for (const r of list) {
      const rMs = ms(r.d, r.t);
      if (rMs == null) continue;
      const win = list.filter(s => { const sMs = ms(s.d, s.t); return sMs != null && Math.abs(sMs - rMs) <= WINDOW_MS; });

      let recCopy = null;
      if (!(r.recording_file && AUDIO_RE.test(r.recording_file))) {
        const withRec = win.filter(s => s.recording_file && AUDIO_RE.test(s.recording_file))
          .sort((a, b) => Math.abs((ms(a.d, a.t) || 0) - rMs) - Math.abs((ms(b.d, b.t) || 0) - rMs));
        if (withRec.length) recCopy = withRec[0].recording_file;
      }
      // Touch rows that involve a VMS pilot, carry junk ("390 14"/"21 14"), or gain a recording.
      const extVms = isVms(r.extension), destVms = isVms(r.destination);
      const needsClean = extVms || destVms || hasJunk(r.extension) || hasJunk(r.destination);
      if (!needsClean && !recCopy) continue;

      // Real answered-extension chain across the call's hops (handles junk + multi-hop).
      const chain = buildChain(knownExts, ...win.flatMap(s => [s.extension, s.destination]));
      const chainStr = chain.length ? chain.join(' | ') : null;

      // extension: keep an already-clean real value; otherwise use the chain (or null)
      const extClean = r.extension && /^\d{2,5}( \| \d{2,5})*$/.test(r.extension) && !extVms;
      const newExt = extClean ? r.extension : chainStr;

      // destination: VMS/junk → last real hop if known, else strip trailing junk (keep pilot)
      let newDest = r.destination;
      if (destVms || hasJunk(r.destination)) {
        newDest = chain.length ? chain[chain.length - 1] : (firstTok(r.destination) || r.destination);
      }

      const extChanged = (r.extension || null) !== (newExt || null);
      const destChanged = (r.destination || null) !== (newDest || null);
      const recChanged = recCopy && recCopy !== r.recording_file;
      if (extChanged || destChanged || recChanged) {
        updates.push({ id: r.id, extension: newExt, destination: newDest, recording_file: recChanged ? recCopy : undefined });
      }
    }
  }

  let recCopied = 0;
  if (updates.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of updates) {
        if (u.recording_file !== undefined) {
          await client.query(`UPDATE call_logs SET extension=$1, destination=$2, recording_file=$3 WHERE id=$4`, [u.extension, u.destination, u.recording_file, u.id]);
          recCopied++;
        } else {
          await client.query(`UPDATE call_logs SET extension=$1, destination=$2 WHERE id=$3`, [u.extension, u.destination, u.id]);
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  console.log(`[Maintenance] VMS extension normalize: ${updates.length} rows updated (${recCopied} recordings attached).`);
  return { updated: updates.length, recCopied };
}

module.exports = {
    pruneAntigravityLogs,
    reconcileCallCounts,
    normalizeVmsExtensions
};
