const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { resolveRecordingFullPath } = require('../services/recordingLinker');

const REC_DIR = process.env.PBX_RECORDINGS_DIR || path.join(__dirname, '../../recordings');

(async () => {
  const { rows } = await pool.query(`
    SELECT id, TO_CHAR(call_date, 'YYYY-MM-DD') AS call_date, call_time, caller, destination, recording_file
    FROM call_logs
    WHERE recording_file IS NOT NULL
      AND recording_file <> ''
      AND recording_file ~* '\\.(wav|mp3|ogg|m4a)$'
    ORDER BY id DESC
  `);

  let exists = 0;
  let missing = 0;
  const samples = [];

  for (const row of rows) {
    const fullPath = resolveRecordingFullPath(row.recording_file, REC_DIR);
    const ok = !!(fullPath && fs.existsSync(fullPath));
    if (ok) exists++;
    else missing++;
    if (samples.length < 20 || !ok) {
      let size = null;
      if (ok) size = fs.statSync(fullPath).size;
      samples.push({
        call_id: row.id,
        call_date: row.call_date,
        call_time: row.call_time,
        caller: row.caller,
        destination: row.destination,
        recording_file: row.recording_file,
        resolved_path: fullPath,
        exists: ok,
        size
      });
    }
  }

  console.log(JSON.stringify({
    linkedRows: rows.length,
    filesExist: exists,
    filesMissing: missing,
    recDir: REC_DIR,
    samples
  }, null, 2));

  await pool.end();
})().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
