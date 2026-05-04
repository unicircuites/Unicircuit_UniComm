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
let phoneNumber = null; // This will store the REAL phone number
let userJid     = null; // This will store the active JID (Phone or LID)
let io          = null;

// In-memory contacts store (name lookup)
const contactsStore = {};
// In-memory imported chat checkpoint to protect against history sync duplicates
let importedLastTsMap = {};

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
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      imported_last_ts TIMESTAMPTZ
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
  await pool.query(`ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS imported_last_ts TIMESTAMPTZ`);

  // Load imported checkpoints into memory
  try {
    const res = await pool.query(`SELECT id, imported_last_ts FROM wa_chats WHERE imported_last_ts IS NOT NULL`);
    for (const r of res.rows) {
      importedLastTsMap[r.id] = new Date(r.imported_last_ts).getTime();
    }
  } catch(e) {}
}

// ── SAVE CHAT ────────────────────────────────────────────────────────────────────────
async function saveChat(rawJid, name, lastMsg, lastTime, unread, isGroup) {
  // Normalize JID: remove device suffixes like :48
  const jid = rawJid.includes('@') ? (rawJid.split(':')[0] + '@' + rawJid.split('@')[1]) : rawJid;
  
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
        unread       = CASE WHEN EXCLUDED.unread = 0 THEN 0 ELSE wa_chats.unread + EXCLUDED.unread END,
        updated_at   = NOW()
    `, [jid, name || displayPhone, displayPhone, isGroup || false, lastMsg || '', ts, unread || 0]);
  } catch (err) {
    console.error(`[WA-DB] saveChat error ${jid}:`, err.message);
  }
}

// ── SAVE / UPDATE CONTACT ──────────────────────────────────────────────────────────────
async function saveContact(contact) {
  if (!contact?.id) return;
  const jid    = contact.id;
  const phone  = jid.split('@')[0].split(':')[0];
  const name   = contact.name || contact.verifiedName || null;
  const notify = contact.notify || null;

  // Update in-memory store
  contactsStore[jid] = { name, notify };

  // Identity Mapping: If this is an LID, link it to the phone number
  if (jid.endsWith('@lid') && contact.phoneNumber) {
    const pNum = typeof contact.phoneNumber === 'string' ? contact.phoneNumber : contact.phoneNumber.jid;
    const phoneJid = pNum.replace(/\D/g,'') + '@s.whatsapp.net';
    contactsStore[jid].phoneJid = phoneJid;
    // Save mapping to DB too for persistence
    pool.query('UPDATE wa_contacts SET phone=$1 WHERE jid=$2', [pNum.replace(/\D/g,''), jid]).catch(()=>{});
  }

  try {
    await pool.query(`
      INSERT INTO wa_contacts (jid, name, notify, phone)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (jid) DO UPDATE SET
        name   = COALESCE(EXCLUDED.name,   wa_contacts.name),
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

    const rawJid      = msg.key.remoteJid;
    // Normalize JID: remove device suffixes and resolve LID to phone if possible
    let jid = rawJid.split(':')[0].split('@')[0] + '@' + rawJid.split('@')[1];
    
    // LID to Phone resolution (from memory or DB)
    if (jid.endsWith('@lid')) {
      const mapped = Object.values(contactsStore).find(c => c.id === jid && c.phoneJid);
      if (mapped) jid = mapped.phoneJid;
    }
    
    const ts          = toDate(msg.messageTimestamp);
    
    // Protect imported chats from receiving duplicate native history syncs
    if (importedLastTsMap[jid] && ts.getTime() <= importedLastTsMap[jid]) {
      return null;
    }

    const id          = msg.key.id;
    const fromMe      = msg.key.fromMe || false;
    // For group messages: participant is in msg.key.participant OR msg.participant
    const participant = msg.key.participant || msg.participant || null;
    // Accept @lid participants too — we store pushName for them
    const isValidSender = participant && !participant.endsWith('@g.us');
    const senderJid   = fromMe ? null : (isValidSender ? participant : null);
    const isGroupMsg  = jid.endsWith('@g.us');

    // Format sender name/number
    let senderName = 'You';
    if (!fromMe) {
      const isLidSender = senderJid && senderJid.endsWith('@lid');
      const sPhone = (!isLidSender && senderJid) ? senderJid.split('@')[0].split(':')[0] : '';
      const resolved = getContactName(senderJid, msg.pushName);

      if (resolved && !/^\+?\d[\d\s]+$/.test(resolved)) {
        // Real contact name from address book
        senderName = resolved;
      } else if (msg.pushName && msg.pushName.trim()) {
        // pushName — always use this, it's the sender's WhatsApp profile name
        senderName = msg.pushName.trim();
      } else if (sPhone.startsWith('91') && sPhone.length === 12) {
        senderName = '+91 ' + sPhone.slice(2,7) + ' ' + sPhone.slice(7);
      } else if (sPhone && sPhone.length >= 7 && sPhone.length <= 15) {
        senderName = '+' + sPhone;
      } else {
        senderName = null;
      }
    }
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
  
  let version = [2, 3000, 1015901307];
  try {
    const res = await fetchLatestBaileysVersion();
    version = res.version;
  } catch (err) {
    console.warn('[WA] Version fetch timeout/error, using fallback v' + version.join('.'));
  }
  
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
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000
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
      const rawId = sock.user?.id || '';
      console.log('[WA] sock.user:', JSON.stringify(sock.user));
      // sock.user.id can be "919545073545:48@s.whatsapp.net" or LID "49868...@lid"
      // Extract real phone: take part before ':' or '@'
      const idPart = rawId.split('@')[0].split(':')[0];
      phoneNumber = idPart || rawId;
      console.log('[WA] Connected as', phoneNumber, '| raw id:', rawId);
      emit('wa:connected', { phone: phoneNumber, name: sock.user?.name });
    }

    if (connection === 'close') {
      isConnected = false;
      const code  = lastDisconnect?.error?.output?.statusCode;
      console.log('[WA] Disconnected. Code:', code);
      emit('wa:disconnected', { code });
      if (code === DisconnectReason.loggedOut) {
        console.log('[WA] Logged out - clearing session. Scan QR to reconnect.');
        clearSession();
        setTimeout(startWA, 1000);
      } else if (code === 408) {
        console.log('[WA] QR timeout - waiting for manual QR request.');
      } else {
        console.log('[WA] Reconnecting in 5s...');
        setTimeout(startWA, 5000);
      }
    }

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

        // Auto-save media to disk so it's available even after cache expires
        const mtype = getContentType(msg.message);
        if (['imageMessage','videoMessage','audioMessage','documentMessage'].includes(mtype)) {
          try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buf = await downloadMediaMessage(msg, 'buffer', {});
            const fs = require('fs');
            const path = require('path');
            const mediaDir = path.join(__dirname, '../wa_media');
            if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
            const ext = mtype === 'imageMessage' ? 'jpg' : mtype === 'videoMessage' ? 'mp4' : mtype === 'audioMessage' ? 'ogg' : 'bin';
            const docMsg = msg.message.documentMessage;
            const fname = docMsg?.fileName || `${msg.key.id}.${ext}`;
            fs.writeFileSync(path.join(mediaDir, msg.key.id + '_' + fname), buf);
          } catch (e) {
            console.warn('[WA] Auto-save media failed:', e.message);
          }
        }
      }
      if (!isRealMessage(msg)) continue;
      // Improved Normalization for @s.whatsapp.net, @g.us, AND @lid
      let jid = rawJid.includes(':') ? (rawJid.split(':')[0] + '@' + rawJid.split('@')[1]) : rawJid;
      
      // If it's an LID, try to find the mapped phone JID
      if (jid.endsWith('@lid')) {
        const contact = Object.values(contactsStore).find(c => c.id === jid && c.phoneJid);
        if (contact) jid = contact.phoneJid;
      }

      console.log(`[WA] Incoming message from ${jid}: ${getBody(msg).substring(0, 30)}`);

      const saved = await saveMessage(msg);
      if (!saved) continue;

      const isGroup = jid.endsWith('@g.us');
      const chatName = isGroup
        ? getContactName(jid, null)
        : getContactName(jid, msg.pushName);

      await saveChat(jid, chatName, saved.body, saved.ts, msg.key.fromMe ? 0 : 1, isGroup);

      if (type === 'notify') {
        console.log(`[WA] Emitting message to UI: ${saved.id}`);
        emit('wa:message', {
          id: saved.id, chatId: jid, fromMe: saved.fromMe,
          sender: saved.sender, senderName: saved.senderName, body: saved.body,
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

  // Load contacts from DB
  const contactsRes = await pool.query(`SELECT jid, name, notify FROM wa_contacts`);
  const dbContacts = {};
  contactsRes.rows.forEach(c => { dbContacts[c.jid] = c; });

  return {
    id: meta.id,
    name: meta.subject,
    description: meta.desc || '',
    participants: meta.participants.map(p => {
      const pJid = p.id;

      // Baileys provides p.phoneNumber for @lid participants — use it directly
      const phoneJid = p.phoneNumber || (pJid.endsWith('@lid') ? null : pJid);
      const rawPhone = phoneJid ? phoneJid.split('@')[0].split(':')[0] : '';

      // Format phone display
      let phoneDisplay = '';
      if (rawPhone && /^\d{7,15}$/.test(rawPhone)) {
        phoneDisplay = rawPhone.startsWith('91') && rawPhone.length === 12
          ? '+91 ' + rawPhone.slice(2,7) + ' ' + rawPhone.slice(7)
          : '+' + rawPhone;
      }

      // Name: DB contact (by real phone JID) → in-memory store → phone number
      const realJid = phoneJid || pJid;
      const stored  = dbContacts[realJid] || dbContacts[pJid]
        || contactsStore[realJid] || contactsStore[pJid];
      const displayName = stored?.name || stored?.notify || phoneDisplay || null;

      return {
        jid:   pJid,
        phone: phoneDisplay,
        name:  displayName,
        admin: p.admin === 'admin' || p.admin === 'superadmin',
      };
    })
  };
}

// ── MEDIA CACHE + DOWNLOAD ─────────────────────────────────────────────────
const msgCache = new Map();
const MAX_CACHE = 500;

async function downloadMedia(msgId) {
  const fs = require('fs');
  const path = require('path');
  const mediaDir = path.join(__dirname, '../wa_media');

  // Check disk first — auto-saved on receive
  if (fs.existsSync(mediaDir)) {
    const files = fs.readdirSync(mediaDir).filter(f => f.startsWith(msgId + '_'));
    if (files.length > 0) {
      const fpath = path.join(mediaDir, files[0]);
      const buffer = fs.readFileSync(fpath);
      const ext = path.extname(files[0]).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.bin': 'application/octet-stream' };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const filename = files[0].replace(msgId + '_', '');
      return { buffer, mime, filename };
    }
  }

  // Fallback: try live download from cache
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
  const phone = getConnectedPhone() || phoneNumber;
  return { connected: isConnected, phone: phone, name: sock?.user?.name || null, hasQR: !!qrString };
}

async function getQR() {
  if (!qrString) return null;
  return qrcode.toDataURL(qrString);
}

// ── WHATSAPP EXPORT CHAT IMPORT ───────────────────────────────────────────
// Parses WhatsApp exported chat (Android / iOS .txt format) and saves to DB.
// Supports:
//   - Android: DD/MM/YYYY, HH:MM - Name: text
//   - iOS:     [DD/MM/YYYY, HH:MM:SS] Name: text
//   - Media files (base64) from zip export — saved to wa_media folder
//   - Smart duplicate prevention — merges into existing chat by phone
//
async function importExportedChat(chatText, chatJid, mediaFiles, clearOld) {
  // mediaFiles = [{ filename, base64, mime }] — from zip extraction on frontend

  if (!chatJid) throw new Error("A valid chat must be selected to import messages.");

  // Ensure tables exist
  await ensureTables();
  await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_path TEXT`);

  // ── STEP 1: Verify chat exists in DB ─────────────────────────────────────
  const existing = await pool.query(`SELECT id, name FROM wa_chats WHERE id=$1`, [chatJid]);
  if (existing.rows.length === 0) {
    throw new Error("The selected chat does not exist in the database. Only synced chats can receive imports.");
  }
  const displayChatName = existing.rows[0].name;

  // ── STEP 1.5: Clean old imports if requested ───────────────────────────
  if (clearOld) {
    // User explicitly requested: "db khali karo uss group ki aur zip ki chats + media db mai daalo"
    await pool.query(`DELETE FROM wa_messages WHERE chat_id=$1`, [chatJid]);
    console.log(`[WA-Import] Wiped entire chat history for ${chatJid} to replace with ZIP`);
  }

  // ── STEP 2: Save media files to wa_media folder ────────────────────────
  const mediaDir = path.join(__dirname, '../wa_media');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

  // Build filename → saved msgId map for linking
  const mediaSavedMap = {}; // originalFilename → { msgId, mime, ext }
  if (Array.isArray(mediaFiles) && mediaFiles.length > 0) {
    for (const mf of mediaFiles) {
      try {
        if (!mf.filename || !mf.base64) continue;
        const buf = Buffer.from(mf.base64, 'base64');
        const ext  = path.extname(mf.filename) || '.bin';
        // Create a stable import msgId from filename
        const fakeMsgId = 'import_' + Buffer.from(mf.filename).toString('base64').replace(/[^a-zA-Z0-9]/g,'').substring(0,24);
        const savedName = fakeMsgId + '_' + mf.filename;
        fs.writeFileSync(path.join(mediaDir, savedName), buf);
        mediaSavedMap[mf.filename.toLowerCase()] = { msgId: fakeMsgId, mime: mf.mime || 'application/octet-stream', ext };
        console.log(`[WA-Import] Saved media: ${savedName}`);
      } catch (e) {
        console.warn(`[WA-Import] Failed to save media ${mf.filename}:`, e.message);
      }
    }
  }

  // ── STEP 4: Parse chat text ────────────────────────────────────────────
  const lines = chatText.split('\n');
  console.log(`[WA-Import] Parsed chatText. lines.length = ${lines.length}`);
  console.log(`[WA-Import] First line preview: ${lines[0]}`);

  let imported = 0;
  let skipped  = 0;
  let mediaLinked = 0;
  let lastTs   = new Date();
  let pendingMsg = null;

  // Regex patterns
  // Android: 02/05/2025, 14:35 - Name: text OR 5/4/26, 1:50 PM - Name: text
  // Using [\s\u202F\u00A0] to handle various Unicode spaces found in exports
  const androidRe = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?[\s\u202F\u00A0]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202F\u00A0]*(am|pm|AM|PM)?[\s\u202F\u00A0]*[-–][\s\u202F\u00A0]*(.+?):\s([\s\S]*)$/;
  // iOS:     [02/05/2025, 14:35:22] Name: text OR [02/05/2025, 1:35:22 PM] Name: text
  const iosRe     = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?[\s\u202F\u00A0]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202F\u00A0]*(am|pm|AM|PM)?\][\s\u202F\u00A0]*(.+?):\s([\s\S]*)$/;

  // Media filename pattern — WhatsApp exports write: "IMG-20240501-WA0012.jpg (file attached)"
  // or just the filename on its own line after the sender prefix. Caption may follow on same line.
  const mediaAttachedRe = /^(.+?\.(jpg|jpeg|png|gif|mp4|mp3|opus|ogg|pdf|docx?|xlsx?|pptx?|zip|aac|m4a|webp|sticker))(?:\s*\(file attached\))?(?:\s+([\s\S]*))?$/i;

  const flush = async () => {
    if (!pendingMsg) return;
    const { ts, senderName, body, msgType, linkedMsgId, linkedMediaPath } = pendingMsg;

    // Skip empty, system, and "without media" placeholders
    if (!body || body.trim() === '') { pendingMsg = null; skipped++; return; }
    const cleanBody = body.replace(/^\u200e|\u200f/g, '').trim();
    if (
      cleanBody === '<Media omitted>' ||
      cleanBody.match(/^(Image|Video|Audio|GIF|Sticker|Contact card|Document) omitted$/) ||
      cleanBody === 'This message was deleted' ||
      cleanBody === 'You deleted this message' ||
      cleanBody === 'null'
    ) {
      if (cleanBody.includes('omitted')) {
        console.log(`[WA-Import] Info: WhatsApp omitted a media file from this export: ${cleanBody}`);
      }
      pendingMsg = null; skipped++; return;
    }

    // Deterministic import message ID (prevents re-import duplicates)
    const msgId = linkedMsgId || (
      'import_' + Buffer.from(ts.toISOString() + senderName + cleanBody.substring(0, 20))
        .toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 32)
    );

    const isFromMe = (senderName === 'You' || senderName === (sock?.user?.name || ''));
    const finalType = msgType || 'text';

    // Resolve body: for media messages, extract caption if any, otherwise empty
    let finalBody = cleanBody;
    if (finalType !== 'text' && finalType !== 'conversation') {
      const match = cleanBody.match(mediaAttachedRe);
      if (match && match[3] && match[3].trim()) {
        finalBody = match[3].trim();
      } else {
        finalBody = ''; // Don't show the raw filename text
      }
    }

    try {
      await pool.query(`
        INSERT INTO wa_messages (id, chat_id, from_me, sender_name, body, msg_type, timestamp, is_read, status, media_path)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true,'read',$8)
        ON CONFLICT (id, chat_id) DO NOTHING
      `, [msgId, chatJid, isFromMe, isFromMe ? 'You' : senderName, finalBody, finalType, ts, linkedMediaPath]);
      imported++;
      lastTs = ts;
    } catch (e) {
      console.warn('[WA-Import] DB insert error:', e.message);
      skipped++;
    }
    pendingMsg = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, '').trimEnd();
    if (!line) {
      if (pendingMsg) pendingMsg.body += '\n';
      continue;
    }

    const cleanLine = line.replace(/^\u200e|\u200f/g, '');
    let match = cleanLine.match(androidRe) || cleanLine.match(iosRe);

    if (match) {
      await flush();

      let [, day, month, year, hh, mm, ss, ampm, senderName, body] = match;
      let hour = parseInt(hh, 10);
      if (ampm) {
        ampm = ampm.toLowerCase();
        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
      }
      hh = hour.toString().padStart(2, '0');

      const yr = year.length === 2 ? '20' + year : year;
      const ts = new Date(`${yr}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${hh}:${mm.padStart(2,'0')}:${(ss||'00').padStart(2,'0')}+05:30`);
      
      const cleanSender = senderName.replace(/^\u200e|\u200f/g, '').trim();
      const cleanBody   = (body || '').replace(/^\u200e|\u200f/g, '').trim();

      // Detect if this line IS a media attachment reference
      let msgType = 'text';
      let linkedMsgId = null;
      let linkedMediaPath = null;

      const mediaMatch = cleanBody.match(mediaAttachedRe);
      if (mediaMatch) {
        const fname = mediaMatch[1].trim();
        const ext   = mediaMatch[2].toLowerCase();
        msgType = ext.match(/^(jpg|jpeg|png|gif|webp)$/) ? 'imageMessage'
                : ext.match(/^(mp4|mov|avi)$/)           ? 'videoMessage'
                : ext.match(/^(mp3|opus|ogg|aac|m4a)$/)  ? 'audioMessage'
                : 'documentMessage';

        // If we have the actual file saved, link its msgId and media path
        const lookup = fname.toLowerCase();
        if (mediaSavedMap[lookup]) {
          linkedMsgId = mediaSavedMap[lookup].msgId;
          linkedMediaPath = mediaSavedMap[lookup].msgId + '_' + fname;
          mediaLinked++;
        }
      }

      pendingMsg = { ts, senderName: cleanSender, body: cleanBody, msgType, linkedMsgId, linkedMediaPath, chatJidLocal: chatJid };
    } else if (pendingMsg) {
      // Continuation of previous multi-line message
      pendingMsg.body += '\n' + line;
    } else {
      // System / date header line — skip
      skipped++;
    }
  }
  await flush(); // flush last message

  // ── STEP 5: Update chat metadata & protect it ──────────────────────────
  await pool.query(`
    UPDATE wa_chats SET last_time=$1, updated_at=NOW(), imported_last_ts=GREATEST(imported_last_ts, $1)
    WHERE id=$2
  `, [lastTs, chatJid]);
  
  importedLastTsMap[chatJid] = new Date(lastTs).getTime();

  console.log(`[WA-Import] Done — imported=${imported} skipped=${skipped} mediaLinked=${mediaLinked} chat=${chatJid} isNew=false`);
  return { imported, skipped, mediaLinked, chatJid, chatName: displayChatName, merged: true };
}

function getConnectedPhone() {
  if (!isConnected) return null;
  // phoneNumber already cleaned (no @ or :) from connection handler
  if (phoneNumber && !String(phoneNumber).includes('@')) return phoneNumber;
  // Fallback: search contactsStore for own mapped phone
  console.log('[WA] getConnectedPhone fallback — phoneNumber:', phoneNumber);
  const mapped = Object.values(contactsStore).find(c => c.phoneJid);
  console.log('[WA] mapped:', mapped ? mapped.phoneJid : 'NOT FOUND');
  return mapped ? mapped.phoneJid.split('@')[0] : (phoneNumber || null);
}

module.exports = { startWA, sendMessage, logout, getStatus, getQR, setIO, getGroupMetadata, downloadMedia, msgCache, importExportedChat, getConnectedPhone };

