/**
 * One-shot backfill / repair for VMS-pilot (390) call legs.
 *
 * Delegates to maintenance.normalizeVmsExtensions (the SAME logic the "Recalculate Counts"
 * button runs), then re-links recordings and refreshes the deduped view. Run once per
 * environment (e.g. on the Tower) after deploying; the live SMDR path keeps new calls clean.
 *
 *   node backend/scripts/backfill_vms_extension.js
 */
const pool = require('../db/pool');
const path = require('path');
const maintenance = require('../services/maintenance');
const { linkRecordingsToCallLogs } = require('../services/recordingLinker');

(async () => {
  // Before
  const before = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE extension = '390')::int ext_390,
            COUNT(*) FILTER (WHERE extension ~ '\\s')::int junk_ext
     FROM call_logs WHERE call_type = 'In'`
  );
  console.log('BEFORE:', JSON.stringify(before.rows[0]));

  // 1. Normalise VMS pilots + junk + attach recordings (idempotent)
  const vms = await maintenance.normalizeVmsExtensions(pool);
  console.log('normalizeVmsExtensions:', JSON.stringify(vms));

  // 2. Re-link any still-unlinked recordings (exact date, 20-min tolerance)
  const REC_DIR = process.env.PBX_RECORDINGS_DIR || path.join(__dirname, '../../recordings');
  const linkRes = await linkRecordingsToCallLogs(REC_DIR);
  console.log('Linker:', JSON.stringify(linkRes));

  // 3. Refresh the deduped view the dashboard reads
  await pool.query('REFRESH MATERIALIZED VIEW call_logs_deduped').catch(e => console.warn('matview refresh:', e.message));

  // After
  const after = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE extension = '390')::int ext_390,
            COUNT(*) FILTER (WHERE extension ~ '\\s')::int junk_ext
     FROM call_logs WHERE call_type = 'In'`
  );
  console.log('AFTER:', JSON.stringify(after.rows[0]));

  await pool.end();
})().catch(async e => { console.error('FATAL', e); await pool.end().catch(() => {}); process.exit(1); });
