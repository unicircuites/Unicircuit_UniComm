const express = require('express');

const fs = require('fs');

const path = require('path');

const pool = require('../db/pool');

const fsp = fs.promises;

const router = express.Router();

global.pbxSyncProgress = {
  running: false,
  total: 0,
  processed: 0,
  inserted: 0,
  duplicates: 0,
  percent: 0,
  currentFile: '',
  completed: false
};

let scanProgress = {

  scanning: false,

  currentFile: '',

  inserted: 0,

  totalProcessed: 0,

  currentFolder: '',

  completed: false

};

const PBX_ROOT =
  'C:\\MatrixVMS\\Voicemail_Backup';

  const LOCAL_RECORDINGS =
  path.join(
    __dirname,
    '..',
    'pbx_recordings'
  );

function buildSnapshotFolderName(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const day = parts.day || String(date.getDate()).padStart(2, '0');
  const month = parts.month || 'Jan';
  const year = parts.year || String(date.getFullYear());
  const hour = parts.hour || '00';
  const minute = parts.minute || '00';
  const second = parts.second || '00';

  return `${day}${month}_${year}_${hour}${minute}${second}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

function safeFolderName(name, fallback = 'UNKNOWN') {
  return String(name || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim() || fallback;
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

router.post(
  '/store-recordings',
  async (req, res) => {

    try {

      scanProgress = {
        scanning: true,
        currentFile: '',
        inserted: 0,
        totalProcessed: 0,
        currentFolder: '',
        completed: false
      };

      global.pbxSyncProgress = {
        running: true,
        total: 0,
        processed: 0,
        inserted: 0,
        duplicates: 0,
        percent: 0,
        currentFile: '',
        completed: false
      };

      // ── STEP 1: Collect ALL wav files from every backup/extension folder ──
      const allWavFiles = [];

      if (!fs.existsSync(PBX_ROOT)) {
        throw new Error(`PBX root not found: ${PBX_ROOT}`);
      }

      const backupFolders = fs.readdirSync(PBX_ROOT);

      for (const backupFolder of backupFolders) {
        scanProgress.currentFolder = backupFolder;
        const backupPath = path.join(PBX_ROOT, backupFolder);

        let bStat;
        try { bStat = fs.statSync(backupPath); } catch (_) { continue; }
        if (!bStat.isDirectory()) continue;

        const extensionFolders = fs.readdirSync(backupPath);

        for (const extensionFolder of extensionFolders) {
          const extensionPath = path.join(backupPath, extensionFolder);

          let eStat;
          try { eStat = fs.statSync(extensionPath); } catch (_) { continue; }
          if (!eStat.isDirectory()) continue;

          const files = fs.readdirSync(extensionPath);

          for (const file of files) {
            scanProgress.totalProcessed++;
            scanProgress.currentFile = file;

            if (!file.toLowerCase().endsWith('.wav')) continue;

            const fullPath = path.join(extensionPath, file);
            const parsed = parseRecording(file);

            allWavFiles.push({
              file,
              backupFolder,
              extensionFolder,
              extensionPath,
              fullPath,
              parsed,
              // Use parsed recordingDate for sorting; fall back to file mtime
              sortDate: parsed.recordingDate
                ? new Date(parsed.recordingDate)
                : (() => { try { return fs.statSync(fullPath).mtime; } catch (_) { return new Date(0); } })()
            });
          }
        }
      }

      // ── STEP 2: Sort newest-date FIRST so DB always has latest at top ──
      allWavFiles.sort((a, b) => b.sortDate - a.sortDate);

      const requestedFolder = safeFolderName(req.body?.snapshotFolder, '');
      const runFolder = requestedFolder || buildSnapshotFolderName();
      const runRoot = path.join(LOCAL_RECORDINGS, runFolder);
      await fsp.mkdir(runRoot, { recursive: true });

      const uniqueWavFiles = [];
      const seenInRun = new Set();
      for (const item of allWavFiles) {
        if (seenInRun.has(item.file)) {
          global.pbxSyncProgress.duplicates++;
          continue;
        }
        seenInRun.add(item.file);
        uniqueWavFiles.push(item);
      }

      global.pbxSyncProgress.total = uniqueWavFiles.length;

      // ── STEP 3: Load already-stored filenames from DB (global dedup) ──
      const existingRes = await pool.query(
        `SELECT id, original_filename FROM pbx_recordings`
      );
      const existingNames = new Map(existingRes.rows.map(r => [r.original_filename, r.id]));

      let inserted = 0;
      let updated = 0;

      // ── STEP 4: Insert only truly new unique files ──
      for (const item of uniqueWavFiles) {
        const { file, backupFolder, extensionFolder, extensionPath, fullPath, parsed } = item;

        global.pbxSyncProgress.processed++;
        global.pbxSyncProgress.currentFile = file;
        global.pbxSyncProgress.percent = global.pbxSyncProgress.total
          ? Math.round((global.pbxSyncProgress.processed / global.pbxSyncProgress.total) * 100)
          : 100;

        // Global dedup — skip if this filename was already stored from ANY folder
        let stats;
        try { stats = fs.statSync(fullPath); } catch (_) {
          console.warn(`[PBX] Skipping missing file: ${fullPath}`);
          continue;
        }

        const safeExtensionFolder = safeFolderName(extensionFolder || parsed.extension || 'UNKNOWN');
        const localFolder = path.join(runRoot, safeExtensionFolder);
        await fsp.mkdir(localFolder, { recursive: true });

        const safeFilename =
          `${parsed.displayName}_EXT${parsed.extension}_${parsed.customer}.wav`;
        const localPath = path.join(localFolder, safeFilename);

        if (!fs.existsSync(localPath)) {
          try {
            await fsp.copyFile(fullPath, localPath);
          } catch (copyErr) {
            console.error(`[PBX] Copy failed for ${file}:`, copyErr.message);
            continue;
          }
        }

        if (existingNames.has(file)) {
          await pool.query(
            `UPDATE pbx_recordings
             SET display_name = $1,
                 extension_number = $2,
                 customer_number = $3,
                 recording_date = $4,
                 file_size = $5,
                 backup_folder = $6,
                 extension_folder = $7,
                 local_path = $8
             WHERE original_filename = $9`,
            [
              safeFilename,
              parsed.extension,
              parsed.customer,
              parsed.recordingDate,
              stats.size,
              runFolder,
              safeExtensionFolder,
              localPath,
              file
            ]
          );
          updated++;
          global.pbxSyncProgress.duplicates++;
          console.log(`[PBX] Existing recording moved to snapshot: ${file} (${runFolder}/${safeExtensionFolder})`);
          continue;
        }

        await pool.query(
          `INSERT INTO pbx_recordings (
            original_filename, display_name, extension_number,
            customer_number, recording_date, file_size,
            backup_folder, extension_folder, local_path
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            file,
            safeFilename,
            parsed.extension,
            parsed.customer,
            parsed.recordingDate,
            stats.size,
            runFolder,
            safeExtensionFolder,
            localPath
          ]
        );

        // Mark as known so later iterations of same name are deduped in-memory
        existingNames.set(file, true);

        inserted++;
        global.pbxSyncProgress.inserted = inserted;
        scanProgress.inserted = inserted;
        console.log(`[PBX] Inserted: ${file} (${runFolder}/${safeExtensionFolder}) from ${backupFolder}/${extensionPath}`);
      }

      scanProgress.completed = true;
      scanProgress.scanning = false;
      global.pbxSyncProgress.running = false;
      global.pbxSyncProgress.completed = true;
      global.pbxSyncProgress.percent = 100;

      console.log('[PBX] Store complete. Folder:', runFolder, '| Inserted:', inserted, '| Updated:', updated, '| Duplicates skipped:', global.pbxSyncProgress.duplicates);

      res.json({
        success: true,
        snapshot_folder: runFolder,
        inserted,
        updated,
        duplicates: global.pbxSyncProgress.duplicates,
        total_scanned: allWavFiles.length,
        total_unique: uniqueWavFiles.length
      });

    } catch (err) {
      global.pbxSyncProgress.running = false;
      global.pbxSyncProgress.completed = true;
      console.error('[PBX STORE ERROR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

function parseRecording(filename) {
  try {
    const clean = path.basename(filename, path.extname(filename));
    const parts = clean.split('_');

    // Matrix filenames can be DDMMYYYY_HHMMSS_CT_Number_Ext
    // or Ext_DDMMYYYY_HHMMSS_CT_Ext_Number. Use the date/time in the white filename.
    const dateIndex = parts.findIndex((part, index) =>
      /^\d{8}$/.test(part || '') && /^\d{6}$/.test(parts[index + 1] || '')
    );
    const datePart = dateIndex >= 0 ? parts[dateIndex] : '';
    const timePart = dateIndex >= 0 ? parts[dateIndex + 1] : '';

    let extension = '';
    let customer = 'UNKNOWN';

    const remaining = parts.filter((p, index) =>
      p &&
      p.toUpperCase() !== 'CT' &&
      index !== dateIndex &&
      index !== dateIndex + 1
    );
    for (const p of remaining) {
      const normalized = normalizePhone(p);
      const digits = normalized.replace(/\D/g, '');

      // Extensions are usually short numeric values like 21, 207, 1001.
      if (/^\d{1,5}$/.test(digits) && normalized === digits) {
        extension = p;
      } else if (digits.length >= 6) {
        customer = normalized || p;
      }
    }

    const validDate = /^\d{8}$/.test(datePart);
    const validTime = /^\d{6}$/.test(timePart);

    let recordingDate = null;
    let displayName = clean;
    let dateFolder = 'unknown';
    let parsedFromFilename = false;

    if (validDate && validTime) {
      const day = datePart.substring(0, 2);
      const month = datePart.substring(2, 4);
      const year = datePart.substring(4, 8);

      const hour = timePart.substring(0, 2);
      const minute = timePart.substring(2, 4);
      const second = timePart.substring(4, 6);

      recordingDate = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
      displayName = `${year}-${month}-${day}_${hour}-${minute}-${second}`;
      dateFolder = `${year}-${month}-${day}`;
      parsedFromFilename = true;
    } else {
      const now = new Date();
      recordingDate = now;
      displayName = clean.replace(/[^a-zA-Z0-9_-]/g, '_');
      dateFolder = now.toISOString().split('T')[0];
    }

    return {
      extension,
      customer,
      recordingDate,
      displayName,
      dateFolder,
      parsedFromFilename
    };
  } catch (err) {
    console.error('[PBX PARSE ERROR]', err);
    const now = new Date();
    return {
      extension: '',
      customer: 'UNKNOWN',
      recordingDate: now,
      displayName: filename.replace(/[^a-zA-Z0-9_-]/g, '_'),
      dateFolder: now.toISOString().split('T')[0],
      parsedFromFilename: false
    };
  }
}

async function backfillPBXRecordingMetadata(backupFolder, extensionFolder) {
  const result = await pool.query(
    `SELECT id, original_filename, customer_number, extension_number, recording_date
     FROM pbx_recordings
     WHERE backup_folder = $1
       AND extension_folder = $2
     LIMIT 5000`,
    [backupFolder, extensionFolder]
  );

  for (const row of result.rows) {
    const parsed = parseRecording(row.original_filename || '');
    await pool.query(
      `UPDATE pbx_recordings
       SET customer_number = COALESCE(NULLIF($1, 'UNKNOWN'), customer_number),
           extension_number = COALESCE(NULLIF($2, ''), extension_number),
           recording_date = CASE WHEN $5::boolean THEN $3 ELSE recording_date END
       WHERE id = $4`,
      [parsed.customer, parsed.extension, parsed.recordingDate, row.id, parsed.parsedFromFilename]
    );
  }
}

router.get(
  '/scan-progress',
  (req, res) => {

    res.json(scanProgress);

  }
);

router.get(
  '/sync-progress',
  (req, res) => {

    res.json(
      global.pbxSyncProgress
    );

  }
);

router.get('/db-folders',
  async (req, res) => {
    try {
      // Group extension folders under backup folders.
      // Order by recording_date DESC so newest backup folders appear first.
      const result = await pool.query(`
        SELECT
          backup_folder,
          extension_folder,
          display_name,
          local_path,
          recording_date
        FROM pbx_recordings
        ORDER BY recording_date DESC NULLS LAST,
                 backup_folder ASC,
                 extension_folder ASC
      `);

      // Build tree: backup_folder → extension_folder → [files]
      // Preserve insertion order (newest backup folder encountered first)
      const tree = {};
      for (const row of result.rows) {
        if (!tree[row.backup_folder]) tree[row.backup_folder] = {};
        if (!tree[row.backup_folder][row.extension_folder])
          tree[row.backup_folder][row.extension_folder] = [];

        tree[row.backup_folder][row.extension_folder].push({
          filename: row.display_name,
          path: row.local_path,
          recording_date: row.recording_date
        });
      }

      res.json(tree);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.get(
  '/db-recordings',
  async (req, res) => {
    try {
      const backupFolder = req.query.backup;
      const extensionFolder = req.query.extension;
      const page = parseInt(req.query.page || '1');
      const limit = parseInt(req.query.limit || '10');
      const offset = (page - 1) * limit;
      const dateFrom = String(req.query.date_from || '').trim();
      const dateTo = String(req.query.date_to || '').trim();
      const timeFrom = String(req.query.time_from || '').trim();
      const timeTo = String(req.query.time_to || '').trim();
      const number = normalizePhone(req.query.number || '');

      if (!backupFolder || !extensionFolder) {
        return res.status(400).json({
          success: false,
          error: 'Missing parameters: backup and extension are required'
        });
      }

      await backfillPBXRecordingMetadata(backupFolder, extensionFolder);

      const where = ['backup_folder = $1', 'extension_folder = $2'];
      const values = [backupFolder, extensionFolder];

      if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        values.push(dateFrom);
        where.push(`recording_date::date >= $${values.length}::date`);
      }

      if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        values.push(dateTo);
        where.push(`recording_date::date <= $${values.length}::date`);
      }

      if (/^\d{2}:\d{2}$/.test(timeFrom)) {
        values.push(`${timeFrom}:00`);
        where.push(`recording_date::time >= $${values.length}::time`);
      }

      if (/^\d{2}:\d{2}$/.test(timeTo)) {
        values.push(`${timeTo}:59`);
        where.push(`recording_date::time <= $${values.length}::time`);
      }

      if (number) {
        values.push(`%${number.replace(/\+/g, '')}%`);
        where.push(`(
          regexp_replace(COALESCE(customer_number, ''), '[^0-9]', '', 'g') ILIKE $${values.length}
          OR regexp_replace(COALESCE(original_filename, ''), '[^0-9]', '', 'g') ILIKE $${values.length}
        )`);
      }

      const whereSql = where.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM pbx_recordings WHERE ${whereSql}`,
        values
      );
      const total = parseInt(countResult.rows[0].count);

      const pageValues = [...values, limit, offset];
      const result = await pool.query(
        `SELECT
           id,
           original_filename,
           display_name,
           extension_number,
           customer_number,
           local_path,
           recording_date,
           file_size
         FROM pbx_recordings
         WHERE ${whereSql}
         ORDER BY recording_date DESC NULLS LAST,
                  id DESC
         LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
        pageValues
      );

      res.json({
        files: result.rows,
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit)
      });
    } catch (err) {
      console.error('[PBX DB RECORDINGS ERROR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.get(
  '/play-db/:id',
    async (req, res) => {

        try {

        const result =
            await pool.query(
            `
            SELECT local_path
            FROM pbx_recordings
            WHERE id = $1
            LIMIT 1
            `,
            [req.params.id]
            );

        if (
            result.rows.length === 0
        ) {

            return res
            .status(404)
            .send('Recording not found');

        }

        const filePath =
            result.rows[0].local_path;

        if (
            !fs.existsSync(filePath)
        ) {

            return res
            .status(404)
            .send('File missing');

        }

        res.sendFile(
            path.resolve(filePath)
        );

        } catch (err) {

        console.error(
            '[PBX PLAY ERROR]',
            err
        );

        res.status(500).send(
            err.message
        );

        }

    }
);

// Start SMDR service on PBX via web automation
router.post('/start-smdr-service', async (req, res) => {
  try {
    console.log('\n[API] POST /pbx/start-smdr-service — Starting SMDR automation...');
    
    const { startSmdrService } = require('../services/matrixSmdrControl');
    const result = await startSmdrService();
    
    res.json(result);
  } catch (err) {
    console.error('[API] Error starting SMDR service:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get SMDR connection status
router.get('/status', (req, res) => {
  try {
    const smdr = require('../services/matrixSmdr');
    const status = {
      listening: smdr.isListening ? smdr.isListening() : false,
      connected: smdr.getStatus ? smdr.getStatus().connected : false,
      port: process.env.SMDR_PORT || 5001,
      pbxHost: process.env.PBX_HOST || '192.168.0.81',
      connectedPeers: smdr.getConnectedPeers ? smdr.getConnectedPeers() : 0,
      lastActivity: smdr.getLastActivity ? smdr.getLastActivity() : null
    };
    res.json(status);
  } catch (err) {
    console.error('[API] Error getting SMDR status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
