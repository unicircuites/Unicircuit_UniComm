const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const pool = require('../db/pool');

const BACKUP_DIR = path.join(__dirname, '../wa_backups');
const MEDIA_DIR = path.join(__dirname, '../wa_media');
const TABLES = ['wa_contacts', 'wa_chats', 'wa_messages'];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupFileName(accountPhone, date = new Date()) {
  return `wa-backup-${safeName(accountPhone)}-${timestampSlug(date)}.json`;
}

function assertInventoryFile(fileName) {
  const base = path.basename(String(fileName || ''));
  if (!/^wa-backup-[a-zA-Z0-9_.-]+\.json$/.test(base)) {
    throw new Error('Invalid backup file name.');
  }
  return path.join(BACKUP_DIR, base);
}

async function readAccountRows(accountPhone) {
  const [contacts, chats, messages] = await Promise.all([
    pool.query(`SELECT * FROM wa_contacts WHERE account_phone=$1 ORDER BY updated_at DESC NULLS LAST`, [accountPhone]),
    pool.query(`SELECT * FROM wa_chats WHERE account_phone=$1 ORDER BY updated_at DESC NULLS LAST, last_time DESC NULLS LAST`, [accountPhone]),
    pool.query(`SELECT * FROM wa_messages WHERE account_phone=$1 ORDER BY timestamp ASC NULLS LAST, created_at ASC NULLS LAST`, [accountPhone]),
  ]);
  return {
    wa_contacts: contacts.rows,
    wa_chats: chats.rows,
    wa_messages: messages.rows,
  };
}

function readMediaPayloads(messages) {
  const media = [];
  const seen = new Set();
  if (!fs.existsSync(MEDIA_DIR)) return media;
  for (const msg of messages) {
    const mediaPath = msg.media_path || msg.mediaPath;
    if (!mediaPath || seen.has(mediaPath)) continue;
    const fullPath = path.join(MEDIA_DIR, path.basename(mediaPath));
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;
    seen.add(mediaPath);
    media.push({
      filename: path.basename(mediaPath),
      size: stat.size,
      contentBase64: fs.readFileSync(fullPath).toString('base64'),
    });
  }
  return media;
}

async function createBackup(accountPhone, reason = 'manual') {
  const normalized = String(accountPhone || '').replace(/\D/g, '');
  if (!normalized) throw new Error('Connected WhatsApp account is required.');
  ensureDir(BACKUP_DIR);
  const rows = await readAccountRows(normalized);
  const payload = {
    format: 'unicomm-wa-backup-v1',
    accountPhone: normalized,
    createdAt: new Date().toISOString(),
    reason,
    counts: {
      contacts: rows.wa_contacts.length,
      chats: rows.wa_chats.length,
      messages: rows.wa_messages.length,
    },
    rows,
    media: readMediaPayloads(rows.wa_messages),
  };
  const fileName = backupFileName(normalized);
  const fullPath = path.join(BACKUP_DIR, fileName);
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf8');
  return {
    fileName,
    fullPath,
    accountPhone: normalized,
    createdAt: payload.createdAt,
    counts: payload.counts,
    mediaFiles: payload.media.length,
  };
}

function listBackups(accountPhone = '') {
  ensureDir(BACKUP_DIR);
  const normalized = String(accountPhone || '').replace(/\D/g, '');
  return fs.readdirSync(BACKUP_DIR)
    .filter(file => /^wa-backup-.*\.json$/.test(file))
    .map(file => {
      const fullPath = path.join(BACKUP_DIR, file);
      let meta = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        meta = {
          accountPhone: parsed.accountPhone,
          createdAt: parsed.createdAt,
          counts: parsed.counts || {},
          mediaFiles: Array.isArray(parsed.media) ? parsed.media.length : 0,
        };
      } catch (_) {}
      return {
        fileName: file,
        size: fs.statSync(fullPath).size,
        ...meta,
      };
    })
    .filter(item => !normalized || item.accountPhone === normalized)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function readBackup(fileName) {
  const fullPath = assertInventoryFile(fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup file not found.');
  const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (payload.format !== 'unicomm-wa-backup-v1') throw new Error('Unsupported WhatsApp backup format.');
  return payload;
}

async function insertRows(client, table, rows, accountPhone) {
  if (!rows.length) return 0;
  const keys = Object.keys(rows[0]).filter(k => k !== 'account_phone');
  const columns = ['account_phone', ...keys];
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
  const conflict = table === 'wa_contacts'
    ? '(jid, account_phone)'
    : table === 'wa_chats'
      ? '(id, account_phone)'
      : '(id, chat_id, account_phone)';
  let inserted = 0;
  for (const row of rows) {
    const values = [accountPhone, ...keys.map(k => row[k])];
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')})
       VALUES (${placeholders})
       ON CONFLICT ${conflict} DO NOTHING`,
      values
    );
    inserted += 1;
  }
  return inserted;
}

async function restoreBackup(fileName, connectedAccountPhone) {
  const accountPhone = String(connectedAccountPhone || '').replace(/\D/g, '');
  if (!accountPhone) throw new Error('WhatsApp must be connected before loading a backup.');
  const payload = readBackup(fileName);
  if (payload.accountPhone !== accountPhone) {
    throw new Error(`Backup belongs to ${payload.accountPhone}; connected account is ${accountPhone}. Restore blocked to prevent chat mixing.`);
  }

  ensureDir(MEDIA_DIR);
  for (const item of payload.media || []) {
    if (!item.filename || !item.contentBase64) continue;
    fs.writeFileSync(path.join(MEDIA_DIR, path.basename(item.filename)), Buffer.from(item.contentBase64, 'base64'));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM wa_messages WHERE account_phone=$1`, [accountPhone]);
    await client.query(`DELETE FROM wa_chats WHERE account_phone=$1`, [accountPhone]);
    await client.query(`DELETE FROM wa_contacts WHERE account_phone=$1`, [accountPhone]);

    const inserted = {};
    for (const table of TABLES) {
      inserted[table] = await insertRows(client, table, payload.rows?.[table] || [], accountPhone);
    }
    await client.query('COMMIT');
    return {
      success: true,
      fileName: path.basename(fileName),
      accountPhone,
      inserted,
      counts: payload.counts || {},
      mediaFiles: (payload.media || []).length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function startDailyBackup(getAccountPhone) {
  cron.schedule('0 18 * * *', async () => {
    try {
      const accountPhone = String(getAccountPhone?.() || '').replace(/\D/g, '');
      if (!accountPhone) {
        console.log('[WA Backup] 6 PM backup skipped: WhatsApp not connected');
        return;
      }
      const result = await createBackup(accountPhone, 'scheduled-6pm');
      console.log('[WA Backup] 6 PM backup created', result);
    } catch (err) {
      console.error('[WA Backup] 6 PM backup failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('[WA Backup] Cron scheduled - daily 6 PM IST');
}

module.exports = {
  createBackup,
  listBackups,
  restoreBackup,
  startDailyBackup,
  backupDir: BACKUP_DIR,
};
