/**
 * WhatsApp Service — Baileys
 * Proper WhatsApp Web-like implementation:
 * - Contacts store (name resolution)
 * - Individual chats + Groups (separate handling)
 * - Real messages only (no protocol/system messages)
 * - Full history sync via messaging-history.set
 */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  makeInMemoryStore,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode');
const path   = require('path');
const fs     = require('fs');
const pool   = require('../db/pool');

// ── STATE ──────────────────────────────────────────────────────────────────
let sock        = null;
let qrString    = null;
let isConnected = false;
let phoneNumber = null;
let io          = null;

// In-memory contacts store (name lookup)
const contactsStore = {};

const AUTH_DIR = path.join(__dirname, '../wa_auth');

function setIO(socketIO) { io = socketIO; }

function emit(event, data) {
  if (io) io.emit(event, data);
}

// ── SAFE TIMESTAMP ─────────────────────────────────────────────────────────
function toDate(ts) {
  if (!ts) return new Date();
  try {
    let secs;
    if (typeof ts === 'object' && ts !== null && typeof ts.toNumber === 'function') {
      secs = ts.toNumber();
    } else if (typeof ts === 'object' && ts !== null && ts.low !== undefined) {
      secs = (ts.low >>> 0) + (ts.high || 0) * 4294967296;
    } else {
      secs = Number(ts);
    }
    if (!secs || isNaN(secs) || secs < 1000000 || secs > 9999999999) return new Date();
    return new Date(secs * 1000);
  } catch (_) { return new Date(); }
}

// ── CONTACT NAME RESOLUTION ────────────────────────────────────────────────
// Priority: saved contact name > pushName > phone number
function getContactName(jid, pushName) {
  const phone = jid ? jid.split('@')[0].split(':')[0] : '';
  const stored = contactsStore[jid] || contactsStore[phone + '@s.whatsapp.net'];
  if (stored?.name)     return stored.name;
  if (stored?.notify)   return stored.notify;
  if (pushName)         return pushName;
  return phone || jid;
}

// ── IS REAL MESSAGE (not system/protocol) ─────────────────────────────────
function isRealMessage(msg) {
  if (!msg?.message) return false;
  const type = getContentType(msg.message);
  if (!type) return false;
  const skip = [
    'protocolMessage', 'senderKeyDistributionMessage',
    'messageContextInfo', 'reactionMessage',
    'pollUpdateMessage', 'callLogMesssage',
    'encReactionMessage', 'ptvMessage',
  ];
  return !skip.includes(type);
}

// ── GET MESSAGE BODY ───────────────────────────────────────────────────────
function getBody(msg) {
  const type = getContentType(msg.message);
  switch (type) {
    case 'conversation':             return msg.message.conversation || '';
    case 'extendedTextMessage':      return msg.message.extendedTextMessage?.text || '';
    case 'imageMessage':             return msg.message.imageMessage?.caption || '📷 Photo';
    case 'videoMessage':             return msg.message.videoMessage?.caption || '🎥 Video';
    case 'audioMessage':             return '🎵 Voice message';
    case 'documentMessage':          return `📄 ${msg.message.documentMessage?.fileName || 'Document'}`;
    case 'stickerMessage':           return '🎭 Sticker';
    case 'locationMessage':          return '📍 Location';
    case 'contactMessage':           return `👤 ${msg.message.contactMessage?.displayName || 'Contact'}`;
    case 'contactsArrayMessage':     return '👥 Contacts';
    case 'liveLocationMessage':      return '📍 Live Location';
    case 'buttonsMessage':           return msg.message.buttonsMessage?.contentText || '🔘 Buttons';
    case 'listMessage':              return msg.message.listMessage?.description || '📋 List';
    case 'templateMessage':          return msg.message.templateMessage?.hydratedTemplate?.hydratedContentText || '📝 Template';
    default:                         return '';
  }
}

// ── ENSURE DB TABLES ───────────────────────────────────────────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_contacts (
      jid          VARCHAR(100) PRIMARY KEY,
      name         VARCHAR(200),
      notify       VARCHAR(200),
      phone        VARCHAR(50),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_chats (
      id           VARCHAR(100) PRIMARY KEY,
      name         VARCHAR(200),
      phone        VARCHAR(50),
      is_group     BOOLEAN DEFAULT FALSE,
      last_message TEXT,
      last_time    TIMESTAMPTZ,
      unread       INT DEFAULT 0,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id           VARCHAR(200),
      chat_id      VARCHAR(100) NOT NULL,
      from_me      BOOLEAN DEFAULT FALSE,
      sender       VARCHAR(100),
      sender_name  VARCHAR(200),
      body         TEXT,
      msg_type     VARCHAR(30) DEFAULT 'text',
      timestamp    TIMESTAMPTZ,
      is_read      BOOLEAN DEFAULT FALSE,
      status       VARCHAR(20) DEFAULT 'sent',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, chat_id)
    )
  `);
}

// ── SAVE / UPDATE CONTACT ──────────────────────────────────────────────────
async function saveContact(contact) {
  if (!contact?.id) return;
  const jid   = contact.id;
  const phone = jid.split('@')[0].split(':')[0];
  const name  = contact.name || contact.verifiedName || null;
  const notify = contact.notify || null;

  // Update in-memory store
  contactsStore[jid] = { name, notify };

  try {
    await pool.query(`
      INSERT INTO wa_contacts (jid, name, notify, phone)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (jid) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, wa_contacts.name),
        notify = COALESCE(EXCLUDED.notify, wa_contacts.notify),
        updated_at = NOW()
    `, [jid, name, notify, phone]);
  } catch (_) {}
}

// ── SAVE CHAT ──────────────────────────────────────────────────────────────
async function saveChat(jid, name, lastMsg, lastTime, unread, isGroup) {
  const phone = jid.split('@')[0].split(':')[0];
  const ts    = lastTime instanceof Date ? lastTime : toDate(lastTime);
  try {
    await pool.query(`
      INSERT INTO wa_chats (id, name, phone, is_group, last_message, last_time, unread)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET
        name         = COALESCE(EXCLUDED.name, wa_chats.name),
        last_message = CASE WHEN EXCLUDED.last_message != '' THEN EXCLUDED.last_message ELSE wa_chats.last_message END,
        last_time    = GREATEST(EXCLUDED.last_time, wa_chats.last_time),
        unread       = wa_chats.unread + EXCLUDED.unread,
        updated_at   = NOW()
    `, [jid, name || phone, phone, isGroup || false, lastMsg || '', ts, unread || 0]);
  } catch (err) {
    console.error(`[WA-DB] saveChat error ${jid}:`, err.message);
  }
}

// ── SAVE MESSAGE ───────────────────────────────────────────────────────────
async function saveMessage(msg) {
  try {
    if (!isRealMessage(msg)) return null;

    const jid        = msg.key.remoteJid;
    const id         = msg.key.id;
    const fromMe     = msg.key.fromMe || false;
    const participant = msg.key.participant || (fromMe ? null : jid);
    const senderJid  = fromMe ? null : (participant || jid);
    const senderName = fromMe ? 'You' : getContactName(senderJid, msg.pushName);
    const ts         = toDate(msg.messageTimestamp);
    const type       = getContentType(msg.message) || 'text';
    const body       = getBody(msg);

    await pool.query(`
      INSERT INTO wa_messages (id, chat_id, from_me, sender, sender_name, body, msg_type, timestamp, is_read)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id, chat_id) DO NOTHING
    `, [id, jid, fromMe, senderJid, senderName, body, type, ts, fromMe]);

    return { id, jid, fromMe, sender: senderJid, senderName, body, type, ts };
  } catch (err) {
    console.error('[WA-DB] saveMessage error:', err.message);
    return null;
  }
}

// ── LOAD CONTACTS FROM DB INTO MEMORY ─────────────────────────────────────
async function loadContactsFromDB() {
  try {
    const res = await pool.query(`SELECT jid, name, notify FROM wa_contacts`);
    res.rows.forEach(r => { contactsStore[r.jid] = { name: r.name, notify: r.notify }; });
    console.log(`[WA] Loaded ${res.rows.length} contacts from DB`);
  } catch (_) {}
}

// ── START WHATSAPP ─────────────────────────────────────────────────────────
async function startWA() {
  await ensureTables();
  await loadContactsFromDB();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();
  console.log('[WA] Starting Baileys v' + version.join('.'));

  sock = makeWASocket({
    version,
    auth:              state,
    printQRInTerminal: false,
    browser:           ['UniComm Pro', 'Chrome', '120.0'],
    syncFullHistory:   true,
    getMessage: async (key) => {
      const res = await pool.query(
        `SELECT body FROM wa_messages WHERE id=$1 AND chat_id=$2`,
        [key.id, key.remoteJid]
      );
      return res.rows[0] ? { conversation: res.rows[0].body } : { conversation: '' };
    },
  });

  // ── CONNECTION ────────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString    = qr;
      isConnected = false;
      console.log('[WA] QR ready — waiting for scan');
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        emit('wa:qr', { qr: qrDataUrl });
      } catch (e) { console.error('[WA] QR error:', e.message); }
    }

    if (connection === 'open') {
      isConnected = true;
      qrString    = null;
      phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id;
      console.log('[WA] ✅ Connected as', phoneNumber);
      emit('wa:connected', { phone: phoneNumber, name: sock.user?.name });
    }

    if (connection === 'close') {
      isConnected = false;
      const code  = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[WA] Disconnected. Code:', code, '| Reconnect:', shouldReconnect);
      emit('wa:disconnected', { code });
      if (shouldReconnect) {
        setTimeout(startWA, 3000);
      } else {
        // Logged out — clear session, restart for fresh QR
        clearSession();
        setTimeout(startWA, 1000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── CONTACTS SYNC ─────────────────────────────────────────────────────────
  sock.ev.on('contacts.upsert', async (contacts) => {
    console.log(`[WA] contacts.upsert count=${contacts.length}`);
    for (const c of contacts) {
      await saveContact(c);
    }
    // Update chat names with resolved contact names
    await updateChatNames();
  });

  sock.ev.on('contacts.update', async (updates) => {
    for (const c of updates) {
      await saveContact(c);
    }
  });

  // ── HISTORY SYNC ──────────────────────────────────────────────────────────
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    console.log(`[WA] History chunk — chats=${chats.length} contacts=${contacts?.length||0} messages=${messages.length} isLatest=${isLatest}`);

    // 1. Save contacts FIRST (needed for name resolution)
    if (contacts?.length) {
      for (const c of contacts) await saveContact(c);
    }

    // 2. Save chats with resolved names
    for (const chat of chats) {
      const isGroup = chat.id.endsWith('@g.us');
      const name    = isGroup
        ? (chat.name || chat.id.split('@')[0])
        : getContactName(chat.id, chat.name);
      const ts = toDate(chat.conversationTimestamp);
      await saveChat(chat.id, name, '', ts, 0, isGroup);
    }

    // 3. Save real messages only
    let saved = 0;
    for (const msg of messages) {
      if (!isRealMessage(msg)) continue;
      const jid = msg.key?.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;
      const result = await saveMessage(msg);
      if (result) {
        saved++;
        const isGroup = jid.endsWith('@g.us');
        const name    = isGroup ? getContactName(jid, null) : getContactName(jid, msg.pushName);
        await saveChat(jid, name, result.body, result.ts, 0, isGroup);
      }
    }
    console.log(`[WA] Chunk saved — ${saved} messages`);

    // 4. Only refresh frontend on FINAL chunk (isLatest=true)
    if (isLatest) {
      console.log('[WA] ✅ Full history sync complete — refreshing UI');
      // Update all chat names now that all contacts are loaded
      await updateChatNames();
      emit('wa:sync_complete', {});
    }
  });

  // ── CHAT LIST UPDATES ─────────────────────────────────────────────────────
  sock.ev.on('chats.upsert', async (chats) => {
    for (const chat of chats) {
      const isGroup = chat.id.endsWith('@g.us');
      const name    = isGroup
        ? (chat.name || chat.id.split('@')[0])
        : getContactName(chat.id, chat.name);
      await saveChat(chat.id, name, '', toDate(chat.conversationTimestamp), 0, isGroup);
    }
    emit('wa:chats_updated', {});
  });

  // ── REAL-TIME MESSAGES ────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!isRealMessage(msg)) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const saved = await saveMessage(msg);
      if (!saved) continue;

      const isGroup = jid.endsWith('@g.us');
      const chatName = isGroup
        ? getContactName(jid, null)
        : getContactName(jid, msg.pushName);

      await saveChat(jid, chatName, saved.body, saved.ts, msg.key.fromMe ? 0 : 1, isGroup);

      if (type === 'notify') {
        emit('wa:message', {
          id: saved.id, chatId: jid, fromMe: saved.fromMe,
          senderName: saved.senderName, body: saved.body,
          type: saved.type, ts: saved.ts,
          chatName,
        });
      }
    }
  });

  // ── MESSAGE STATUS ────────────────────────────────────────────────────────
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.status) {
        const statusMap = { 1:'sent', 2:'delivered', 3:'read', 4:'played' };
        const status = statusMap[update.status] || 'sent';
        await pool.query(
          `UPDATE wa_messages SET status=$1 WHERE id=$2 AND chat_id=$3`,
          [status, key.id, key.remoteJid]
        );
        emit('wa:status', { id: key.id, status });
      }
    }
  });

  // ── GROUP METADATA ────────────────────────────────────────────────────────
  sock.ev.on('groups.upsert', async (groups) => {
    for (const g of groups) {
      await pool.query(
        `UPDATE wa_chats SET name=$1 WHERE id=$2`,
        [g.subject || g.id, g.id]
      );
      contactsStore[g.id] = { name: g.subject };
    }
  });

  sock.ev.on('groups.update', async (updates) => {
    for (const g of updates) {
      if (g.subject) {
        await pool.query(`UPDATE wa_chats SET name=$1 WHERE id=$2`, [g.subject, g.id]);
        contactsStore[g.id] = { name: g.subject };
      }
    }
  });

  return sock;
}

// ── UPDATE CHAT NAMES AFTER CONTACTS SYNC ─────────────────────────────────
async function updateChatNames() {
  try {
    const chats = await pool.query(`SELECT id, phone, name, is_group FROM wa_chats`);
    let updated = 0;
    for (const chat of chats.rows) {
      if (chat.is_group) continue; // Groups keep their own names
      const resolvedName = getContactName(chat.id, null);
      // Only update if we have a better name than the phone number
      if (resolvedName && resolvedName !== chat.phone && resolvedName !== chat.name) {
        await pool.query(`UPDATE wa_chats SET name=$1 WHERE id=$2`, [resolvedName, chat.id]);
        updated++;
      }
    }
    console.log(`[WA] Updated ${updated} chat names`);
  } catch (err) {
    console.error('[WA] updateChatNames error:', err.message);
  }
}

// ── CLEAR SESSION ─────────────────────────────────────────────────────────
function clearSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.readdirSync(AUTH_DIR).forEach(f => fs.unlinkSync(path.join(AUTH_DIR, f)));
      console.log('[WA] Session cleared');
    }
  } catch (e) { console.warn('[WA] clearSession error:', e.message); }
}

// ── SEND MESSAGE ───────────────────────────────────────────────────────────
async function sendMessage(jid, text) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
  const result = await sock.sendMessage(formattedJid, { text });
  const ts = new Date();
  await pool.query(`
    INSERT INTO wa_messages (id, chat_id, from_me, sender_name, body, msg_type, timestamp, is_read, status)
    VALUES ($1,$2,true,'You',$3,'text',$4,true,'sent')
    ON CONFLICT (id, chat_id) DO NOTHING
  `, [result.key.id, formattedJid, text, ts]);
  await saveChat(formattedJid, null, text, ts, 0, formattedJid.endsWith('@g.us'));
  return result;
}

// ── LOGOUT ────────────────────────────────────────────────────────────────
async function logout() {
  console.log('[WA] Logging out...');
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    sock = null; isConnected = false; qrString = null; phoneNumber = null;
  }
  clearSession();
  setTimeout(startWA, 500);
}

// ── STATUS / QR ───────────────────────────────────────────────────────────
function getStatus() {
  return { connected: isConnected, phone: phoneNumber, name: sock?.user?.name || null, hasQR: !!qrString };
}

async function getQR() {
  if (!qrString) return null;
  return qrcode.toDataURL(qrString);
}

module.exports = { startWA, sendMessage, logout, getStatus, getQR, setIO };
