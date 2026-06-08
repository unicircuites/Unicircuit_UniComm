const fs      = require('fs');
const path    = require('path');
const cron    = require('node-cron');
const pool    = require('../db/pool');
const archiver = require('archiver');
const unzipper = require('unzipper');

const BACKUP_DIR = path.join(__dirname, '../wa_backups');
const MEDIA_DIR  = path.join(__dirname, '../wa_media');
const TABLES     = ['wa_contacts', 'wa_chats', 'wa_messages'];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function backupFileName(accountPhone, date = new Date()) {
  const slug = date.toISOString().replace(/[:.]/g, '-');
  return `wa-backup-${safeName(accountPhone)}-${slug}.zip`;
}

async function readAccountRows(accountPhone) {
  const [contacts, chats, messages] = await Promise.all([
    pool.query(`SELECT * FROM wa_contacts WHERE account_phone=$1 ORDER BY updated_at DESC NULLS LAST`, [accountPhone]),
    pool.query(`SELECT * FROM wa_chats    WHERE account_phone=$1 ORDER BY updated_at DESC NULLS LAST, last_time DESC NULLS LAST`, [accountPhone]),
    pool.query(`SELECT * FROM wa_messages WHERE account_phone=$1 ORDER BY timestamp ASC NULLS LAST, created_at ASC NULLS LAST`, [accountPhone]),
  ]);
  return {
    wa_contacts: contacts.rows,
    wa_chats:    chats.rows,
    wa_messages: messages.rows,
  };
}

// Collect list of media filenames referenced in messages that exist on disk
function collectMediaFiles(messages) {
  const files = [];
  const seen  = new Set();
  if (!fs.existsSync(MEDIA_DIR)) return files;
  for (const msg of messages) {
    const p = msg.media_path || msg.mediaPath;
    if (!p || seen.has(p)) continue;
    const fullPath = path.join(MEDIA_DIR, path.basename(p));
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      seen.add(p);
      files.push({ name: path.basename(p), fullPath });
    }
  }
  return files;
}

// Create a .zip backup: metadata.json + media/ folder
async function createBackup(accountPhone, reason = 'manual') {
  const normalized = String(accountPhone || '').replace(/\D/g, '');
  if (!normalized) throw new Error('Connected WhatsApp account is required.');
  ensureDir(BACKUP_DIR);

  const rows       = await readAccountRows(normalized);
  const mediaFiles = collectMediaFiles(rows.wa_messages);

  const metadata = {
    format:       'unicomm-wa-backup-v2',
    accountPhone: normalized,
    createdAt:    new Date().toISOString(),
    reason,
    counts: {
      contacts: rows.wa_contacts.length,
      chats:    rows.wa_chats.length,
      messages: rows.wa_messages.length,
      media:    mediaFiles.length,
    },
    rows,
  };

  const fileName = backupFileName(normalized);
  const fullPath = path.join(BACKUP_DIR, fileName);

  await new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(fullPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(JSON.stringify(metadata), { name: 'metadata.json' });
    for (const { name, fullPath: fp } of mediaFiles) {
      archive.file(fp, { name: `media/${name}` });
    }
    archive.finalize();
  });

  const stat = fs.statSync(fullPath);
  return {
    fileName,
    fullPath,
    accountPhone: normalized,
    createdAt:    metadata.createdAt,
    counts:       metadata.counts,
    sizeBytes:    stat.size,
  };
}

function listBackups(accountPhone = '') {
  ensureDir(BACKUP_DIR);
  const normalized = String(accountPhone || '').replace(/\D/g, '');
  return fs.readdirSync(BACKUP_DIR)
    .filter(file => /^wa-backup-.*\.zip$/.test(file))
    .map(file => {
      const fullPath = path.join(BACKUP_DIR, file);
      return { fileName: file, size: fs.statSync(fullPath).size };
    })
    .filter(item => !normalized || item.fileName.includes(normalized))
    .sort((a, b) => b.fileName.localeCompare(a.fileName));
}

// Restore from a .zip file path on disk
async function restoreBackup(zipPath, connectedAccountPhone) {
  const accountPhone = String(connectedAccountPhone || '').replace(/\D/g, '');
  if (!accountPhone) throw new Error('WhatsApp must be connected before loading a backup.');

  // Extract zip into a temp object
  let metadata = null;
  const mediaBuffers = {}; // filename -> Buffer

  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    if (entry.path === 'metadata.json') {
      const buf = await entry.buffer();
      metadata = JSON.parse(buf.toString('utf8'));
    } else if (entry.path.startsWith('media/')) {
      const fname = path.basename(entry.path);
      if (fname) mediaBuffers[fname] = await entry.buffer();
    }
  }

  if (!metadata) throw new Error('Invalid backup: metadata.json missing');
  if (metadata.format !== 'unicomm-wa-backup-v1' && metadata.format !== 'unicomm-wa-backup-v2') {
    throw new Error('Unsupported backup format');
  }
  const backupPhone = String(metadata.accountPhone || '').replace(/\D/g, '');
  if (backupPhone !== accountPhone) {
    throw new Error(`Backup belongs to +${backupPhone}; connected account is +${accountPhone}. Restore blocked.`);
  }

  // Write media files to disk
  ensureDir(MEDIA_DIR);
  for (const [fname, buf] of Object.entries(mediaBuffers)) {
    fs.writeFileSync(path.join(MEDIA_DIR, fname), buf);
  }

  // Restore DB rows
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM wa_messages WHERE account_phone=$1`, [accountPhone]);
    await client.query(`DELETE FROM wa_chats    WHERE account_phone=$1`, [accountPhone]);
    await client.query(`DELETE FROM wa_contacts WHERE account_phone=$1`, [accountPhone]);

    const inserted = {};
    for (const table of TABLES) {
      inserted[table] = await insertRows(client, table, metadata.rows?.[table] || [], accountPhone);
    }
    await client.query('COMMIT');
    return {
      success: true,
      accountPhone,
      inserted,
      counts:     metadata.counts || {},
      mediaFiles: Object.keys(mediaBuffers).length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function insertRows(client, table, rows, accountPhone) {
  if (!rows.length) return 0;
  const keys    = Object.keys(rows[0]).filter(k => k !== 'account_phone');
  const columns = ['account_phone', ...keys];
  const conflict = table === 'wa_contacts'
    ? '(jid, account_phone)'
    : table === 'wa_chats'
      ? '(id, account_phone)'
      : '(id, chat_id, account_phone)';
  let inserted = 0;
  for (const row of rows) {
    const values = [accountPhone, ...keys.map(k => row[k])];
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT ${conflict} DO NOTHING`,
      values
    );
    inserted++;
  }
  return inserted;
}

function startDailyBackup(getAccountPhone) {
  cron.schedule('0 18 * * *', async () => {
    try {
      const accountPhone = String(getAccountPhone?.() || '').replace(/\D/g, '');
      if (!accountPhone) { console.log('[WA Backup] 6 PM backup skipped: WA not connected'); return; }
      const result = await createBackup(accountPhone, 'scheduled-6pm');
      console.log('[WA Backup] 6 PM backup created', result);
    } catch (err) {
      console.error('[WA Backup] 6 PM backup failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('[WA Backup] Cron scheduled - daily 6 PM IST');
}

module.exports = { createBackup, listBackups, restoreBackup, startDailyBackup, backupDir: BACKUP_DIR };
