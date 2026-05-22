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

      let inserted = 0;

      const allWavFiles = [];

      const backupFolders =
        fs.readdirSync(PBX_ROOT);

      for (const backupFolder of backupFolders) {

        scanProgress.currentFolder = backupFolder;

        const backupPath =
          path.join(
            PBX_ROOT,
            backupFolder
          );

        if (
          !fs
            .statSync(backupPath)
            .isDirectory()
        ) {
          continue;
        }

        const extensionFolders =
          fs.readdirSync(backupPath);

        for (
          const extensionFolder
          of extensionFolders
        ) {

          const extensionPath =
            path.join(
              backupPath,
              extensionFolder
            );

          if (
            !fs
              .statSync(extensionPath)
              .isDirectory()
          ) {
            continue;
          }

          const files =
            fs.readdirSync(extensionPath);

          

          for (const file of files) {

            console.log(
                '[PBX]',
                'Processing:',
                file
                );

            scanProgress.currentFile = file;

            scanProgress.totalProcessed++;

            

            if (
              !file
                .toLowerCase()
                .endsWith('.wav')
            ) {
              continue;
            }

            allWavFiles.push({

            file,

            backupFolder,

            extensionFolder,

            extensionPath

            });

            continue;

          }

        }

      }

      global.pbxSyncProgress.total =
        allWavFiles.length;

        for (const item of allWavFiles) {

        const {

            file,

            backupFolder,

            extensionFolder,

            extensionPath

        } = item;

        global.pbxSyncProgress.processed++;

        global.pbxSyncProgress.currentFile =
            file;

        global.pbxSyncProgress.percent =
            Math.round(
            (
                global.pbxSyncProgress.processed /
                global.pbxSyncProgress.total
            ) * 100
            );

        const existing =
            await pool.query(
            `
            SELECT id
            FROM pbx_recordings
            WHERE original_filename = $1
            AND backup_folder = $2
            AND extension_folder = $3
            LIMIT 1
            `,
            [
                file,
                backupFolder,
                extensionFolder
            ]
            );

        if (
            existing.rows.length > 0
        ) {

            global.pbxSyncProgress.duplicates++;

            continue;

        }

        const fullPath =
            path.join(
            extensionPath,
            file
            );

        const stats =
            fs.statSync(fullPath);

        const parsed =
            parseRecording(file);

        const localFolder =
            path.join(
            LOCAL_RECORDINGS,
            parsed.dateFolder
            );

        await fsp.mkdir(
            localFolder,
            { recursive: true }
        );

        const safeFilename =
            `${parsed.displayName}` +
            `_EXT${parsed.extension}` +
            `_${parsed.customer}.wav`;

        const localPath =
            path.join(
            localFolder,
            safeFilename
            );

        if (
            fs.existsSync(localPath)
        ) {

            global.pbxSyncProgress.duplicates++;

            continue;

        }

        await fsp.copyFile(
            fullPath,
            localPath
        );

        await pool.query(
            `
            INSERT INTO pbx_recordings (

            original_filename,

            display_name,

            extension_number,

            customer_number,

            recording_date,

            file_size,

            backup_folder,

            extension_folder,

            local_path

            )

            VALUES (

            $1,$2,$3,$4,$5,
            $6,$7,$8,$9

            )
            `,
            [

            file,

            safeFilename,

            parsed.extension,

            parsed.customer,

            parsed.recordingDate,

            stats.size,

            backupFolder,

            extensionFolder,

            localPath

            ]
        );

        inserted++;

        global.pbxSyncProgress.inserted =
            inserted;

        scanProgress.inserted =
            inserted;

        }

      scanProgress.completed = true;

      scanProgress.scanning = false;

      console.log(
        '[PBX]',
        'Completed.',
        'Inserted:',
        inserted
        );

      global.pbxSyncProgress.running =
        false;

        global.pbxSyncProgress.completed =
        true;

        global.pbxSyncProgress.percent =
        100;

      res.json({

        success: true,

        inserted

      });

    } catch (err) {

      global.pbxSyncProgress.running =
        false;

      global.pbxSyncProgress.completed =
        true;

      console.error(
        '[PBX STORE ERROR]',
        err
      );

      res.status(500).json({

        success: false,

        error: err.message

      });

    }

  }
);

function parseRecording(filename) {

  try {

    const clean =
      filename.replace('.wav', '');

    const parts =
      clean.split('_');

    const extension =
      parts[0] || '';

    const datePart =
      parts[1] || '';

    const timePart =
      parts[2] || '';

    const customer =
      parts[5] || 'UNKNOWN';

    // VALIDATE DATE/TIME FORMAT
    const validDate =
      /^\d{8}$/.test(datePart);

    const validTime =
      /^\d{6}$/.test(timePart);

    let recordingDate = null;

    let displayName = clean;

    let dateFolder = 'unknown';

    if (validDate && validTime) {

      const day =
        datePart.substring(0, 2);

      const month =
        datePart.substring(2, 4);

      const year =
        datePart.substring(4, 8);

      const hour =
        timePart.substring(0, 2);

      const minute =
        timePart.substring(2, 4);

      const second =
        timePart.substring(4, 6);

      recordingDate =
        `${year}-${month}-${day} ${hour}:${minute}:${second}`;

      displayName =
        `${year}-${month}-${day}_${hour}-${minute}-${second}`;

      dateFolder =
        `${year}-${month}-${day}`;

    } else {

      // FALLBACK SAFE VALUES
      const now = new Date();

      recordingDate =
        now;

      displayName =
        clean.replace(/[^a-zA-Z0-9_-]/g, '_');

      dateFolder =
        now.toISOString().split('T')[0];

    }

    return {

      extension,

      customer,

      recordingDate,

      displayName,

      dateFolder

    };

  } catch (err) {

    console.error(
      '[PBX PARSE ERROR]',
      err
    );

    const now = new Date();

    return {

      extension: '',

      customer: 'UNKNOWN',

      recordingDate: now,

      displayName:
        filename.replace(/[^a-zA-Z0-9_-]/g, '_'),

      dateFolder:
        now.toISOString().split('T')[0]

    };

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

      const result =
        await pool.query(`
          SELECT
            backup_folder,
            extension_folder,
            display_name,
            local_path
          FROM pbx_recordings
          ORDER BY backup_folder,
          extension_folder
        `);

      const tree = {};

      for (const row of result.rows) {

        if (
          !tree[row.backup_folder]
        ) {

          tree[row.backup_folder] = {};

        }

        if (
          !tree[row.backup_folder][row.extension_folder]
        ) {

          tree[row.backup_folder][row.extension_folder] = [];

        }

        tree[row.backup_folder][
          row.extension_folder
        ].push({

          filename:
            row.display_name,

          path:
            row.local_path

        });

      }

      res.json(tree);

    } catch (err) {

      console.error(err);

      res.status(500).json({
        success: false,
        error: err.message
      });

    }

  }
);

router.get(
  '/db-recordings',
  async (req, res) => {

    try {

      const backupFolder =
        req.query.backup;

      const extensionFolder =
        req.query.extension;

      if (
        !backupFolder ||
        !extensionFolder
      ) {

        return res.status(400).json({
          success: false,
          error: 'Missing parameters'
        });

      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            original_filename,
            display_name,
            local_path,
            recording_date,
            file_size
          FROM pbx_recordings
          WHERE backup_folder = $1
          AND extension_folder = $2
          ORDER BY recording_date DESC
          `,
          [
            backupFolder,
            extensionFolder
          ]
        );

      res.json(result.rows);

    } catch (err) {

      console.error(
        '[PBX DB RECORDINGS ERROR]',
        err
      );

      res.status(500).json({
        success: false,
        error: err.message
      });

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