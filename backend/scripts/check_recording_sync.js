const pool = require('../db/pool');
const { linkRecordingsToCallLogs } = require('../services/recordingLinker');
const path = require('path');

const REC_DIR = process.env.PBX_RECORDINGS_DIR || path.join(__dirname, '../../recordings');

async function query(label, sql, params = []) {
  const result = await pool.query(sql, params);
  console.log(`\n${label}`);
  console.log(JSON.stringify(result.rows, null, 2));
  return result.rows;
}

(async () => {
  await query('Latest stored recordings', `
    SELECT id, original_filename, extension_number, customer_number, recording_date, local_path
    FROM pbx_recordings
    ORDER BY id DESC
    LIMIT 10
  `);

  await query('Call-log recording status before linker', `
    SELECT
      COUNT(*)::int AS total_call_logs,
      COUNT(*) FILTER (
        WHERE recording_file IS NOT NULL
          AND recording_file <> ''
          AND recording_file ~* '\\.(wav|mp3|ogg|m4a)$'
      )::int AS linked_playable_call_logs
    FROM call_logs
  `);

  console.log('\nRunning linker...');
  const linkResult = await linkRecordingsToCallLogs(REC_DIR);
  console.log(JSON.stringify(linkResult, null, 2));

  await query('Call-log recording status after linker', `
    SELECT
      COUNT(*)::int AS total_call_logs,
      COUNT(*) FILTER (
        WHERE recording_file IS NOT NULL
          AND recording_file <> ''
          AND recording_file ~* '\\.(wav|mp3|ogg|m4a)$'
      )::int AS linked_playable_call_logs
    FROM call_logs
  `);

  await query('Latest linked call logs', `
    SELECT id, TO_CHAR(call_date, 'YYYY-MM-DD') AS call_date, call_time, caller, destination,
           extension, duration, call_type, recording_file
    FROM call_logs
    WHERE recording_file IS NOT NULL
      AND recording_file <> ''
      AND recording_file ~* '\\.(wav|mp3|ogg|m4a)$'
    ORDER BY id DESC
    LIMIT 10
  `);

  await pool.end();
})().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
