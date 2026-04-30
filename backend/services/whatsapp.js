/**
 * WhatsApp Service â€” Baileys
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
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const pool   = require('../db/pool');

// â”€â”€ STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ SAFE TIMESTAMP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ CONTACT NAME RESOLUTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Priority: saved contact name > pushName > formatted phone number
function getContactName(jid, pushName) {
  if (!jid) return '';
  const phone = jid.split('@')[0].split(':')[0];
  const stored = contactsStore[jid] || contactsStore[phone + '@s.whatsapp.net'];
  if (stored?.name)   return stored.name;
  if (stored?.notify) return stored.notify;
  if (pushName)       return pushName;
  // Format Indian number: 91XXXXXXXXXX â†’ +91 XXXXX XXXXX
  if (phone.startsWith('91') && phone.length === 12) {
    return '+91 ' + phone.slice(2, 7) + ' ' + phone.slice(7);
  }
  return '+' + phone;
}

// â”€â”€ IS REAL MESSAGE (not system/protocol) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ GET MESSAGE BODY + METADATA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getBody(msg) {
  const type = getContentType(msg.message);
  switch (type) {
    case 'conversation':             return msg.message.conversation || '';
    case 'extendedTextMessage':      return msg.message.extendedTextMessage?.text || '';
    case 'imageMessage':             return msg.message.imageMessage?.caption || '';
    case 'videoMessage':             return msg.message.videoMessage?.caption || '';
    case 'audioMessage':             return '';
    case 'documentMessage':          return msg.message.documentMessage?.fileName || 'Document';
    case 'stickerMessage':           return '';
    case 'locationMessage':          return `${msg.message.locationMessage?.degreesLatitude},${msg.message.locationMessage?.degreesLongitude}`;
    case 'contactMessage':           return msg.message.contactMessage?.displayName || 'Contact';
    case 'contactsArrayMessage':     return 'Contacts';
    case 'buttonsMessage':           return msg.message.buttonsMessage?.contentText || '';
    case 'listMessage':              return msg.message.listMessage?.description || '';
    default:                         return '';
  }
}

function getMsgIcon(type) {
  const icons = {
    imageMessage: 'ðŸ“·', videoMessage: 'ðŸŽ¥', audioMessage: 'ðŸŽµ',
    documentMessage: 'ðŸ“„', stickerMessage: 'ðŸŽ­', locationMessage: 'ðŸ“',
    contactMessage: 'ðŸ‘¤', contactsArrayMessage: 'ðŸ‘¥',
  };
  return icons[type] || '';
}

function getQuotedBody(msg) {
  try {
    const ctx = msg.message?.extendedTextMessage?.contextInfo
      || msg.message?.imageMessage?.contextInfo
      || msg.message?.videoMessage?.contextInfo
      || msg.message?.documentMessage?.contextInfo
      || msg.message?.audioMessage?.contextInfo;
    if (!ctx?.quotedMessage) return null;
    const qtype = getContentType(ctx.quotedMessage);
    if (qtype === 'conversation') return ctx.quotedMessage.conversation;
    if (qtype === 'extendedTextMessage') return ctx.quotedMessage.extendedTextMessage?.text;
    return getMsgIcon(qtype) + ' ' + (qtype || '');
  } catch (_) { return null; }
}

// â”€â”€ ENSURE DB TABLES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      quoted_body  TEXT,
      timestamp    TIMESTAMPTZ,
      is_read      BOOLEAN DEFAULT FALSE,
      status       VARCHAR(20) DEFAULT 'sent',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, chat_id)
    )
  `);
  await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS quoted_body TEXT`);
}

// â”€â”€ SAVE / UPDATE CONTACT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ SAVE CHAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function saveChat(jid, name, lastMsg, lastTime, unread, isGroup) {
  const phone = jid.split('@')[0].split(':')[0];
  // Format Indian number properly
  let displayPhone;
  if (phone.startsWith('91') && phone.length === 12) {
    displayPhone = '+91 ' + phone.slice(2, 7) + ' ' + phone.slice(7);
  } else {
    displayPhone = '+' + phone;
  }
  const ts = lastTime instanceof Date ? lastTime : toDate(lastTime);
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
    `, [jid, name || displayPhone, displayPhone, isGroup || false, lastMsg || '', ts, unread || 0]);
  } catch (err) {
    console.error(`[WA-DB] saveChat error ${jid}:`, err.message);
  }
}

// â”€â”€ SAVE MESSAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function saveMessage(msg) {
  try {
    if (!isRealMessage(msg)) return null;

    const jid         = msg.key.remoteJid;
    const id          = msg.key.id;
    const fromMe      = msg.key.fromMe || false;
    const participant = msg.key.participant || (fromMe ? null : jid);
    const senderJid   = fromMe ? null : (participant || jid);
    // Format sender phone for display
    let senderName = 'You';
    if (!fromMe) {
      const sPhone = senderJid ? senderJid.split('@')[0].split(':')[0] : '';
      senderName = getContactName(senderJid, msg.pushName) ||
        (sPhone.startsWith('91') && sPhone.length === 12
          ? '+91 ' + sPhone.slice(2,7) + ' ' + sPhone.slice(7)
          : '+' + sPhone);
    }
    const ts          = toDate(msg.messageTimestamp);
    const type        = getContentType(msg.message) || 'text';
    const body        = getBody(msg);
    const quotedBody  = getQuotedBody(msg);

    await pool.query(`
      INSERT INTO wa_messages (id, chat_id, from_me, sender, sender_name, body, msg_type, timestamp, is_read, quoted_body)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id, chat_id) DO NOTHING
    `, [id, jid, fromMe, senderJid, senderName, body, type, ts, fromMe, quotedBody]);

    return { id, jid, fromMe, sender: senderJid, senderName, body, type, ts, quotedBody };
  } catch (err) {
    console.error('[WA-DB] saveMessage error:', err.message);
    return null;
  }
}

// â”€â”€ LOAD CONTACTS FROM DB INTO MEMORY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadContactsFromDB() {
  try {
    const res = await pool.query(`SELECT jid, name, notify FROM wa_contacts`);
    res.rows.forEach(r => { contactsStore[r.jid] = { name: r.name, notify: r.notify }; });
    console.log(`[WA] Loaded ${res.rows.length} contacts from DB`);
  } catch (_) {}
}

// â”€â”€ START WHATSAPP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ CONNECTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString    = qr;
      isConnected = false;
      console.log('[WA] QR ready â€” waiting for scan');
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        emit('wa:qr', { qr: qrDataUrl });
      } catch (e) { console.error('[WA] QR error:', e.message); }
    }

    if (connection === 'open') {
      isConnected = true;
      qrString    = null;
      phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id;
      console.log('[WA] âœ… Connected as', phoneNumber);
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
        // Logged out â€” clear session, restart for fresh QR
        clearSession();
        setTimeout(startWA, 1000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // â”€â”€ CONTACTS SYNC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ HISTORY SYNC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    console.log(`[WA] History chunk â€” chats=${chats.length} contacts=${contacts?.length||0} messages=${messages.length} isLatest=${isLatest}`);

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

    // 3. Save real messages + cache for media download
    let saved = 0;
    for (const msg of messages) {
      if (msg.key && msg.key.id && msg.message) {
        msgCache.set(msg.key.id, msg);
        if (msgCache.size > MAX_CACHE) msgCache.delete(msgCache.keys().next().value);
      }
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
    console.log(`[WA] Chunk saved â€” ${saved} messages`);

    // 4. Only refresh frontend on FINAL chunk (isLatest=true)
    if (isLatest) {
      console.log('[WA] âœ… Full history sync complete â€” refreshing UI');
      // Update all chat names now that all contacts are loaded
      await updateChatNames();
      emit('wa:sync_complete', {});
    }
  });

  // â”€â”€ CHAT LIST UPDATES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ REAL-TIME MESSAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // Cache for media download
      if (msg.key && msg.key.id && msg.message) {
        msgCache.set(msg.key.id, msg);
        if (msgCache.size > MAX_CACHE) msgCache.delete(msgCache.keys().next().value);
      }
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

  // â”€â”€ MESSAGE STATUS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ GROUP METADATA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ UPDATE CHAT NAMES AFTER CONTACTS SYNC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function updateChatNames() {
  try {
    const chats = await pool.query(`SELECT id, phone, name, is_group FROM wa_chats`);
    let updated = 0;
    for (const chat of chats.rows) {
      if (chat.is_group) continue;
      const resolvedName = getContactName(chat.id, null);
      const phone = chat.id.split('@')[0].split(':')[0];
      const displayPhone = '+' + phone;
      // Update if we have a real name (not just the phone number)
      if (resolvedName && resolvedName !== displayPhone && resolvedName !== phone) {
        await pool.query(`UPDATE wa_chats SET name=$1 WHERE id=$2`, [resolvedName, chat.id]);
        updated++;
      } else if (chat.name !== displayPhone && !chat.is_group) {
        // Ensure phone is displayed with + prefix
        await pool.query(`UPDATE wa_chats SET phone=$1 WHERE id=$2 AND name NOT LIKE '+%'`, [displayPhone, chat.id]);
      }
    }
    console.log(`[WA] Updated ${updated} chat names`);
  } catch (err) {
    console.error('[WA] updateChatNames error:', err.message);
  }
}

// â”€â”€ CLEAR SESSION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function clearSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.readdirSync(AUTH_DIR).forEach(f => fs.unlinkSync(path.join(AUTH_DIR, f)));
      console.log('[WA] Session cleared');
    }
  } catch (e) { console.warn('[WA] clearSession error:', e.message); }
}

// â”€â”€ SEND MESSAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── SEND MESSAGE WITH OPTIONAL REPLY ──────────────────────────────────────
async function sendMessage(jid, text, quotedMsgId) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const formattedJid = jid.includes('@') ? jid : jid + '@s.whatsapp.net';

  let sendOptions = { text };

  // Build quoted message for reply
  if (quotedMsgId) {
    try {
      const res = await pool.query(
        `SELECT body, from_me, sender FROM wa_messages WHERE id=$1 AND chat_id=$2`,
        [quotedMsgId, formattedJid]
      );
      if (res.rows[0]) {
        // Baileys quoted message format
        sendOptions.quoted = {
          key: {
            id:        quotedMsgId,
            remoteJid: formattedJid,
            fromMe:    res.rows[0].from_me,
            participant: res.rows[0].from_me ? undefined : (res.rows[0].sender || undefined),
          },
          message: { conversation: res.rows[0].body || '' },
        };
        console.log('[WA] Sending reply to:', quotedMsgId);
      }
    } catch (e) {
      console.warn('[WA] Could not build quoted message:', e.message);
    }
  }

  const result = await sock.sendMessage(formattedJid, sendOptions);
  const ts = new Date();
  await pool.query(
    `INSERT INTO wa_messages (id, chat_id, from_me, sender_name, body, msg_type, timestamp, is_read, status, quoted_body)
     VALUES ($1,$2,true,'You',$3,'text',$4,true,'sent',$5)
     ON CONFLICT (id, chat_id) DO NOTHING`,
    [result.key.id, formattedJid, text, ts, quotedMsgId ? `↩ Reply` : null]
  );
  await saveChat(formattedJid, null, text, ts, 0, formattedJid.endsWith('@g.us'));
  return result;
}

// ── GROUP METADATA ─────────────────────────────────────────────────────────
async function getGroupMetadata(jid) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const meta = await sock.groupMetadata(jid);
  return {
    id: meta.id, name: meta.subject, description: meta.desc || '',
    participants: meta.participants.map(function(p) {
      const phone = p.id.split('@')[0].split(':')[0];
      // Try contact store first
      const stored = contactsStore[p.id] || contactsStore[phone + '@s.whatsapp.net'];
      let display;
      if (stored?.name)   display = stored.name;
      else if (stored?.notify) display = stored.notify;
      else if (phone.startsWith('91') && phone.length === 12) {
        display = '+91 ' + phone.slice(2,7) + ' ' + phone.slice(7);
      } else {
        display = '+' + phone;
      }
      return {
        jid:   p.id,
        phone: phone,
        name:  display,
        admin: p.admin === 'admin' || p.admin === 'superadmin',
      };
    })
  };
}

// ── MEDIA CACHE + DOWNLOAD ─────────────────────────────────────────────────
const msgCache = new Map();
const MAX_CACHE = 500;

async function downloadMedia(msgId) {
  const cached = msgCache.get(msgId);
  if (!cached) throw new Error('Message not in cache. Only recent messages can be downloaded.');
  const { downloadMediaMessage } = require('@whiskeysockets/baileys');
  const buffer = await downloadMediaMessage(cached, 'buffer', {});
  const type = getContentType(cached.message);
  const docMsg = cached.message.documentMessage;
  const imgMsg = cached.message.imageMessage;
  const vidMsg = cached.message.videoMessage;
  const audMsg = cached.message.audioMessage;
  const filename = docMsg?.fileName || (type === 'imageMessage' ? 'image.jpg' : type === 'videoMessage' ? 'video.mp4' : type === 'audioMessage' ? 'voice.ogg' : 'file.bin');
  const mime = docMsg?.mimetype || imgMsg?.mimetype || vidMsg?.mimetype || audMsg?.mimetype || 'application/octet-stream';
  return { buffer, mime, filename };
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

module.exports = { startWA, sendMessage, logout, getStatus, getQR, setIO, getGroupMetadata, downloadMedia, msgCache };



