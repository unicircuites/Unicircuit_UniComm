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
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pool = require('../db/pool');

let sharp = null;
function getSharp() {
  if (!sharp) sharp = require('sharp');
  return sharp;
}

// ── STATE ───────────────────────────────────────────────────────────────────────────
let sock = null;
let qrString = null;
let isConnected = false;
let phoneNumber = null; // This will store the REAL phone number
let userJid = null; // This will store the active JID (Phone or LID)
let io = null;
let currentState = 'INIT'; // INIT | QR_READY | CONNECTED | DISCONNECTED | RECONNECTING
let reconnectAttempts = 0;
let reconnectTimer = null;
let startInProgress = false;
let socketGeneration = 0;
let allowQrGeneration = false;
let groupParticipantSyncing = false;
let lastGroupParticipantSyncAt = 0;
// Reconnect detection: first connect uses sync_complete for UI refresh;
// on reconnect Baileys replays chats.upsert — emit wa:chats_updated once after settle.
let hasConnectedBefore = false;
let isReconnect = false;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAYS = [2000, 5000, 10000, 15000, 30000]; // Progressive delays
const GROUP_PARTICIPANT_SYNC_INTERVAL_MS = 30 * 60 * 1000;

// In-memory contacts store (name lookup)
const contactsStore = {};
// In-memory imported chat checkpoint to protect against history sync duplicates
let importedLastTsMap = {};
// In-memory group metadata cache to prevent hangs on large groups
const groupMetadataCache = new Map();

const AUTH_DIR = path.join(__dirname, '../wa_auth');

function hasSavedSession() {
  return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
}

function setIO(socketIO) { io = socketIO; }

function emit(event, data) {
  if (io) io.emit(event, data);
}

// Helper: Normalize JID to prevent double domains and device suffixes
function formatJid(jid) {
  if (!jid) return jid;
  let clean = jid.trim().toLowerCase();

  // Aggressively collapse any redundant domain suffixes
  const parts = clean.split('@');
  const idPart = parts[0].split(':')[0]; // Also strip device suffixes like :48
  let domain = 's.whatsapp.net';

  if (clean.includes('@g.us')) domain = 'g.us';
  else if (clean.includes('@lid')) domain = 'lid';
  else if (clean.includes('@newsletter')) domain = 'newsletter';
  else if (clean.includes('@broadcast')) domain = 'broadcast';

  return `${idPart}@${domain}`;
}

// Helper: Schedule reconnect with exponential backoff
function scheduleReconnect(reason) {
  if (reconnectTimer) {
    console.log('[WA] Reconnect already scheduled; keeping existing timer.');
    return;
  }
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log(`[WA] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping auto-reconnect.`);
    currentState = 'DISCONNECTED';
    emit('wa:reconnect_failed', { attempts: reconnectAttempts });
    return;
  }

  const delayIndex = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
  const delay = RECONNECT_DELAYS[delayIndex];
  reconnectAttempts++;
  currentState = 'RECONNECTING';

  console.log(`[WA] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms (reason: ${reason})`);
  emit('wa:reconnecting', { attempt: reconnectAttempts, delay, reason });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log(`[WA] Executing reconnect attempt ${reconnectAttempts}`);
    startWA().catch(err => {
      console.error('[WA] Reconnect start failed:', err.message);
      scheduleReconnect('reconnect start failed');
    });
  }, delay);
}

// ── SAFE TIMESTAMP ────────────────────────────────────────────────────────────────
function toDate(ts) {
  if (!ts) return null;
  try {
    let secs;
    if (typeof ts === 'object' && ts !== null && typeof ts.toNumber === 'function') {
      secs = ts.toNumber();
    } else if (typeof ts === 'object' && ts !== null && ts.low !== undefined) {
      secs = (ts.low >>> 0) + (ts.high || 0) * 4294967296;
    } else {
      secs = Number(ts);
    }
    if (!secs || isNaN(secs) || secs < 1000000 || secs > 9999999999) return null;
    return new Date(secs * 1000);
  } catch (_) { return null; }
}

// ── CONTACT NAME RESOLUTION ───────────────────────────────────────────────────────
// Priority: saved contact name > pushName > formatted phone number
function getContactName(jid, pushName) {
  if (!jid) return '';
  const phone = jid.split('@')[0].split(':')[0];
  // Check all possible JID formats: exact, @s.whatsapp.net, @lid
  const stored = contactsStore[jid]
    || contactsStore[phone + '@s.whatsapp.net']
    || contactsStore[phone + '@lid'];
  if (stored?.name) return stored.name;
  if (stored?.notify) return stored.notify;
  if (pushName) return pushName;
  // Format Indian number: 91XXXXXXXXXX → +91 XXXXX XXXXX
  if (phone.startsWith('91') && phone.length === 12) {
    return '+91 ' + phone.slice(2, 7) + ' ' + phone.slice(7);
  }
  return '+' + phone;
}

// ── IS REAL MESSAGE (not system/protocol) ────────────────────────────────────────
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

// ── GET MESSAGE BODY + METADATA ─────────────────────────────────────────────────
function getBody(msg) {
  const type = getContentType(msg.message);
  switch (type) {
    case 'conversation': return msg.message.conversation || '';
    case 'extendedTextMessage': return msg.message.extendedTextMessage?.text || '';
    case 'imageMessage': return msg.message.imageMessage?.caption || '';
    case 'videoMessage': return msg.message.videoMessage?.caption || '';
    case 'audioMessage': return '';
    case 'documentMessage': return msg.message.documentMessage?.caption || msg.message.documentMessage?.fileName || 'Document';
    case 'stickerMessage': return 'Sticker';
    case 'locationMessage': return `${msg.message.locationMessage?.degreesLatitude},${msg.message.locationMessage?.degreesLongitude}`;
    case 'contactMessage': return msg.message.contactMessage?.displayName || 'Contact';
    case 'contactsArrayMessage': return 'Contacts';
    case 'buttonsMessage': return msg.message.buttonsMessage?.contentText || '';
    case 'listMessage': return msg.message.listMessage?.description || '';
    case 'buttonsResponseMessage':
      return msg.message.buttonsResponseMessage?.selectedDisplayText
        || msg.message.buttonsResponseMessage?.selectedButtonId
        || '';
    case 'listResponseMessage':
      return msg.message.listResponseMessage?.title
        || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
        || '';
    case 'templateButtonReplyMessage':
      return msg.message.templateButtonReplyMessage?.selectedDisplayText
        || msg.message.templateButtonReplyMessage?.selectedId
        || '';
    case 'interactiveResponseMessage': {
      const response = msg.message.interactiveResponseMessage;
      return response?.body?.text
        || response?.nativeFlowResponseMessage?.name
        || response?.nativeFlowResponseMessage?.paramsJson
        || '';
    }
    default: return '';
  }
}

function getMsgIcon(type) {
  const icons = {
    imageMessage: '📷', videoMessage: '🎥', audioMessage: '🎵',
    documentMessage: '📄', stickerMessage: '🎭', locationMessage: '📍',
    contactMessage: '👤', contactsArrayMessage: '👥',
  };
  return icons[type] || '';
}

function getQuotedBody(msg) {
  try {
    const ctx = msg.message?.extendedTextMessage?.contextInfo
      || msg.message?.imageMessage?.contextInfo
      || msg.message?.videoMessage?.contextInfo
      || msg.message?.documentMessage?.contextInfo
      || msg.message?.stickerMessage?.contextInfo
      || msg.message?.audioMessage?.contextInfo;
    if (!ctx?.quotedMessage) return null;
    const qtype = getContentType(ctx.quotedMessage);
    if (qtype === 'conversation') return ctx.quotedMessage.conversation;
    if (qtype === 'extendedTextMessage') return ctx.quotedMessage.extendedTextMessage?.text;
    return getMsgIcon(qtype) + ' ' + (qtype || '');
  } catch (_) { return null; }
}

// Get reply information (is this message a reply + what message ID it's replying to)
function getReplyInfo(msg) {
  try {
    const ctx = msg.message?.extendedTextMessage?.contextInfo
      || msg.message?.imageMessage?.contextInfo
      || msg.message?.videoMessage?.contextInfo
      || msg.message?.documentMessage?.contextInfo
      || msg.message?.stickerMessage?.contextInfo
      || msg.message?.audioMessage?.contextInfo;
    if (!ctx?.quotedMessage || !ctx?.stanzaId) {
      return { isReply: false, replyToMsgId: null };
    }
    return { isReply: true, replyToMsgId: ctx.stanzaId };
  } catch (_) {
    return { isReply: false, replyToMsgId: null };
  }
}

// ── ENSURE DB TABLES ──────────────────────────────────────────────────────────
async function ensureTables(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wa_contacts (
          jid          VARCHAR(100),
          account_phone VARCHAR(50),
          name         VARCHAR(200),
          notify       VARCHAR(200),
          phone        VARCHAR(50),
          updated_at   TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (jid, account_phone)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wa_chats (
          id           VARCHAR(100),
          account_phone VARCHAR(50),
          name         VARCHAR(200),
          phone        VARCHAR(50),
          is_group     BOOLEAN DEFAULT FALSE,
          last_message TEXT,
          last_time    TIMESTAMPTZ,
          unread       INT DEFAULT 0,
          updated_at   TIMESTAMPTZ DEFAULT NOW(),
          imported_last_ts TIMESTAMPTZ,
          PRIMARY KEY (id, account_phone)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wa_messages (
          id           VARCHAR(200),
          chat_id      VARCHAR(100) NOT NULL,
          account_phone VARCHAR(50),
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
          is_reply     BOOLEAN DEFAULT FALSE,
          reply_to_msg_id VARCHAR(200),
          media_path   TEXT,
          PRIMARY KEY (id, chat_id, account_phone)
        )
      `);
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS quoted_body TEXT`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS is_reply BOOLEAN DEFAULT FALSE`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS reply_to_msg_id VARCHAR(200)`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_path TEXT`).catch(() => { });
      await pool.query(`ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS imported_last_ts TIMESTAMPTZ`).catch(() => { });

      // Handle migrations for multi-account support on existing databases (e.g. Tower Server)
      await pool.query(`ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS account_phone VARCHAR(50) DEFAULT 'unknown'`).catch(() => { });
      await pool.query(`ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS account_phone VARCHAR(50) DEFAULT 'unknown'`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS account_phone VARCHAR(50) DEFAULT 'unknown'`).catch(() => { });

      try {
        await pool.query(`ALTER TABLE wa_contacts DROP CONSTRAINT IF EXISTS wa_contacts_pkey CASCADE`);
        await pool.query(`ALTER TABLE wa_contacts ADD PRIMARY KEY (jid, account_phone)`);
      } catch(e) {}

      try {
        await pool.query(`ALTER TABLE wa_chats DROP CONSTRAINT IF EXISTS wa_chats_pkey CASCADE`);
        await pool.query(`ALTER TABLE wa_chats ADD PRIMARY KEY (id, account_phone)`);
      } catch(e) {}

      try {
        await pool.query(`ALTER TABLE wa_messages DROP CONSTRAINT IF EXISTS wa_messages_pkey CASCADE`);
        await pool.query(`ALTER TABLE wa_messages ADD PRIMARY KEY (id, chat_id, account_phone)`);
      } catch(e) {}

      // Load imported checkpoints into memory
      try {
        const res = await pool.query(`SELECT id, imported_last_ts FROM wa_chats WHERE imported_last_ts IS NOT NULL`);
        for (const r of res.rows) {
          importedLastTsMap[r.id] = new Date(r.imported_last_ts).getTime();
        }
      } catch (e) { }

      return; // Success
    } catch (err) {
      console.warn(`[WA] Table ensure attempt ${i + 1} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// ── SAVE CHAT ────────────────────────────────────────────────────────────────────────
async function saveChat(rawJid, name, lastMsg, lastTime, unread, isGroup) {
  // Normalize JID: strip device suffix (colon before @) e.g. '9195:42@s.whatsapp.net' -> '9195@s.whatsapp.net'
  // For LIDs like '18064@lid' there is no colon so the local part stays unchanged
  let jid = rawJid;
  if (rawJid.includes('@')) {
    const atIdx = rawJid.indexOf('@');
    const localPart = rawJid.substring(0, atIdx);
    const fullDomain = rawJid.substring(atIdx + 1);
    const domain = fullDomain.split('@')[0]; // Strip double suffixes like @g.us@g.us
    const cleanLocal = localPart.includes(':') ? localPart.split(':')[0] : localPart;
    jid = cleanLocal + '@' + domain;
  }

  const phone = jid.split('@')[0].split(':')[0];
  const isGroupChat = !!isGroup || jid.endsWith('@g.us');
  // Format Indian number properly
  let displayPhone;
  if (isGroupChat) {
    displayPhone = null;
  } else if (phone.startsWith('91') && phone.length === 12) {
    displayPhone = '+91 ' + phone.slice(2, 7) + ' ' + phone.slice(7);
  } else {
    displayPhone = '+' + phone;
  }
  const cleanName = String(name || '').trim();
  const groupIdLocal = jid.split('@')[0].split(':')[0];
  const safeName = isGroupChat && (cleanName === groupIdLocal || cleanName === ('+' + groupIdLocal))
    ? null
    : (cleanName || null);
  const ts = lastTime instanceof Date ? lastTime : toDate(lastTime);
  try {
    const accPhone = phoneNumber || 'unknown';
    await pool.query(`
      INSERT INTO wa_chats (id, account_phone, name, phone, is_group, last_message, last_time, unread)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id, account_phone) DO UPDATE SET
        name         = COALESCE(EXCLUDED.name, wa_chats.name),
        phone        = COALESCE(EXCLUDED.phone, wa_chats.phone),
        is_group     = wa_chats.is_group OR EXCLUDED.is_group,
        last_message = CASE WHEN EXCLUDED.last_message != '' THEN EXCLUDED.last_message ELSE wa_chats.last_message END,
        last_time    = GREATEST(COALESCE(EXCLUDED.last_time, wa_chats.last_time), COALESCE(wa_chats.last_time, EXCLUDED.last_time)),
        unread       = CASE WHEN EXCLUDED.unread = 0 THEN 0 ELSE wa_chats.unread + EXCLUDED.unread END,
        updated_at   = NOW()
    `, [jid, accPhone, safeName || displayPhone, displayPhone, isGroupChat, lastMsg || '', ts, unread || 0]);
  } catch (err) {
    console.error(`[WA-DB] saveChat error ${jid}:`, err.message);
  }
}

// ── SAVE / UPDATE CONTACT ──────────────────────────────────────────────────────────────
async function saveContact(contact) {
  if (!contact?.id) return;
  const jid = contact.id;
  let phone = jid.split('@')[0].split(':')[0];
  const name = contact.name || contact.verifiedName || null;
  const notify = contact.notify || null;

  // Update in-memory store
  contactsStore[jid] = { name, notify };

  // Identity Mapping: If this is an LID, extract the real phone number
  if (jid.endsWith('@lid') && contact.phoneNumber) {
    const pNum = typeof contact.phoneNumber === 'string' ? contact.phoneNumber : contact.phoneNumber.jid;
    const realPhone = pNum.replace(/\D/g, '');
    phone = realPhone; // Use real phone instead of LID number
    const phoneJid = realPhone + '@s.whatsapp.net';
    contactsStore[jid].phoneJid = phoneJid;
  }

  try {
    const accPhone = phoneNumber || 'unknown';
    await pool.query(`
      INSERT INTO wa_contacts (jid, account_phone, name, notify, phone)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (jid, account_phone) DO UPDATE SET
        name   = COALESCE(EXCLUDED.name,   wa_contacts.name),
        notify = COALESCE(EXCLUDED.notify, wa_contacts.notify),
        phone  = COALESCE(EXCLUDED.phone,  wa_contacts.phone),
        updated_at = NOW()
    `, [jid, accPhone, name, notify, phone]);
  } catch (_) { }
}

// ── SAVE MESSAGE ──────────────────────────────────────────────────────────────────────
async function saveMessage(msg) {
  try {
    if (!isRealMessage(msg)) return null;

    const rawJid = msg.key.remoteJid;
    // Normalize JID: remove device suffixes and resolve LID to phone if possible
    let jid = rawJid.split(':')[0].split('@')[0] + '@' + rawJid.split('@')[1];

    // LID to Phone resolution (from memory or DB)
    if (jid.endsWith('@lid')) {
      const mapped = Object.values(contactsStore).find(c => c.id === jid && c.phoneJid);
      if (mapped) jid = mapped.phoneJid;
    }

    const ts = toDate(msg.messageTimestamp);

    // Protect imported chats from receiving duplicate native history syncs
    if (importedLastTsMap[jid] && ts.getTime() <= importedLastTsMap[jid]) {
      return null;
    }

    const id = msg.key.id;
    const fromMe = msg.key.fromMe || false;
    // For group messages: participant is in msg.key.participant OR msg.participant
    const participant = msg.key.participant || msg.participant || null;
    // Accept @lid participants too — we store pushName for them
    const isValidSender = participant && !participant.endsWith('@g.us');
    const senderJid = fromMe ? null : (isValidSender ? participant : null);
    const isGroupMsg = jid.endsWith('@g.us');

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
        senderName = '+91 ' + sPhone.slice(2, 7) + ' ' + sPhone.slice(7);
      } else if (sPhone && sPhone.length >= 7 && sPhone.length <= 15) {
        senderName = '+' + sPhone;
      } else {
        senderName = null;
      }
    }
    const type = getContentType(msg.message) || 'text';
    const body = getBody(msg);
    let quotedBody = getQuotedBody(msg);
    const replyInfo = getReplyInfo(msg);

    const mediaPath = msg.mediaPath || null;
    let isReply = false;

    try {
      const ctx =
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.imageMessage?.contextInfo ||
        msg.message?.videoMessage?.contextInfo ||
        msg.message?.documentMessage?.contextInfo ||
        msg.message?.stickerMessage?.contextInfo ||
        msg.message?.audioMessage?.contextInfo;

      if (ctx?.stanzaId) {
        isReply = true;
      }

      const quotedMsg = ctx?.quotedMessage;

      if (quotedMsg && !quotedBody) {
        quotedBody =
          quotedMsg.conversation ||
          quotedMsg.extendedTextMessage?.text ||
          quotedMsg.imageMessage?.caption ||
          quotedMsg.videoMessage?.caption ||
          quotedMsg.documentMessage?.fileName ||
          (quotedMsg.stickerMessage ? '[Sticker]' : null) ||
          (quotedMsg.imageMessage ? '[Image]' :
            quotedMsg.videoMessage ? '[Video]' :
              quotedMsg.documentMessage ? '[Document]' :
                '[Media]');
      }
    } catch (e) { }
    const accPhone = phoneNumber || 'unknown';
    await pool.query(`
      INSERT INTO wa_messages (id, chat_id, account_phone, from_me, sender, sender_name, body, msg_type, timestamp, is_read, quoted_body, is_reply, reply_to_msg_id, media_path)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id, chat_id, account_phone) DO NOTHING
    `, [id, jid, accPhone, fromMe, senderJid, senderName, body, type, ts, fromMe, quotedBody, replyInfo.isReply, replyInfo.replyToMsgId, mediaPath]);

    return { id, jid, fromMe, sender: senderJid, senderName, body, type, ts, quotedBody, isReply: replyInfo.isReply, replyToMsgId: replyInfo.replyToMsgId, mediaPath };
  } catch (err) {
    console.error('[WA-DB] saveMessage error:', err.message);
    return null;
  }
}

// ── LOAD CONTACTS FROM DB INTO MEMORY ──────────────────────────────────────────────────
async function loadContactsFromDB() {
  try {
    const accPhone = phoneNumber || 'unknown';
    // Include phone so LID entries get their phoneJid pre-populated for group msg rendering
    const res = await pool.query(`SELECT jid, name, notify, phone FROM wa_contacts WHERE account_phone=$1`, [accPhone]);
    res.rows.forEach(r => {
      const entry = { name: r.name, notify: r.notify };
      // Pre-populate phoneJid for @lid contacts so saveMessage can resolve senders immediately
      if (r.jid.endsWith('@lid') && r.phone) {
        entry.phoneJid = r.phone + '@s.whatsapp.net';
      }
      contactsStore[r.jid] = entry;
      // Also index by phone number for cross-format lookup
      const phone = r.jid.split('@')[0].split(':')[0];
      if (phone && !contactsStore[phone]) {
        contactsStore[phone] = { name: r.name, notify: r.notify };
      }
    });
    const lidCount = res.rows.filter(r => r.jid.endsWith('@lid') && r.phone).length;
    console.log(`[WA] Loaded ${res.rows.length} contacts from DB (${lidCount} LID→phone mappings)`);
  } catch (_) { }
}

// ── LOAD LID→PHONE MAP FROM DB AFTER CONNECT ──────────────────────────────────────────
// Called immediately after wa:connected so group message senders resolve without waiting
// for live Baileys contact events (which may not fire on reconnect).
async function loadLidPhoneMapFromDB() {
  try {
    const accPhone = phoneNumber || 'unknown';
    const res = await pool.query(
      `SELECT jid, phone FROM wa_contacts WHERE account_phone=$1 AND jid LIKE '%@lid' AND phone IS NOT NULL AND phone != ''`,
      [accPhone]
    );
    let mapped = 0;
    for (const r of res.rows) {
      if (!contactsStore[r.jid]) contactsStore[r.jid] = {};
      contactsStore[r.jid].phoneJid = r.phone + '@s.whatsapp.net';
      mapped++;
    }
    console.log(`[WA] LID→phone map refreshed: ${mapped} entries`);
  } catch (err) {
    console.error('[WA] loadLidPhoneMapFromDB error:', err.message);
  }
}

// ── START WHATSAPP ────────────────────────────────────────────────────────────────────
async function startWA(options = {}) {
  const allowQR = !!options.allowQR;
  if (allowQR) allowQrGeneration = true;

  if (startInProgress) {
    console.log('[WA] startWA ignored: start already in progress');
    return;
  }
  if (sock && isConnected) {
    console.log('[WA] startWA ignored: already connected');
    return;
  }

  startInProgress = true;
  const generation = ++socketGeneration;
  await ensureTables();
  await loadContactsFromDB();
  // Update chat names from contacts on every startup
  await updateChatNames();

  if (!allowQrGeneration && !hasSavedSession()) {
    console.log('[WA] No saved session. WhatsApp will stay idle until QR is requested from WhatsApp Biz.');
    currentState = 'DISCONNECTED';
    startInProgress = false;
    return;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version = [2, 3000, 1017539718]; // Updated fallback to a more recent version
  try {
    const res = await fetchLatestBaileysVersion();
    version = res.version;
  } catch (err) {
    console.warn('[WA] Version fetch timeout/error, using fallback v' + version.join('.'));
  }

  console.log('[WA] Starting Baileys v' + version.join('.'));

  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) { }
    try { sock.end?.(); } catch (_) { }
  }

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['UniComm Pro', 'Chrome', '120.0'],
    syncFullHistory: true,  // true = ensures full history is downloaded (faster, prevents sync stuck)
    logger: require('pino')({ level: 'info' }), // Enabled info level to see Baileys internal logs
    getMessage: async (key) => {
      const res = await pool.query(
        `SELECT body FROM wa_messages WHERE id=$1 AND chat_id=$2 AND account_phone=$3`,
        [key.id, key.remoteJid, phoneNumber || 'unknown']
      );
      return res.rows[0] ? { conversation: res.rows[0].body } : { conversation: '' };
    },
    connectTimeoutMs: 45000,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: true,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 5
  });
  startInProgress = false;

  // ── CONNECTION ────────────────────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    if (generation !== socketGeneration) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (!allowQrGeneration) {
        qrString = null;
        isConnected = false;
        currentState = 'DISCONNECTED';
        console.log('[WA] QR generated by Baileys but suppressed until user requests WhatsApp Biz QR.');
        try { sock.ev.removeAllListeners(); } catch (_) { }
        try { sock.end?.(); } catch (_) { }
        sock = null;
        return;
      }
      qrString = qr;
      isConnected = false;
      currentState = 'QR_READY';
      console.log('[WA] QR ready — waiting for scan');
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        emit('wa:qr', { qr: qrDataUrl });
      } catch (e) { console.error('[WA] QR error:', e.message); }
    }

    if (connection === 'open') {
      // Detect reconnect BEFORE updating state
      isReconnect = hasConnectedBefore;
      hasConnectedBefore = true;

      isConnected = true;
      currentState = 'CONNECTED';
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      qrString = null;
      const rawId = sock.user?.id || '';

      // sock.user.id can be "919545073545:48@s.whatsapp.net" or LID "49868...@lid"
      // Extract real phone: take part before ':' or '@'
      const idPart = rawId.split('@')[0].split(':')[0];
      phoneNumber = idPart || rawId;
      console.log(`[WA] Connected as ${phoneNumber} | raw id: ${rawId} | reconnect: ${isReconnect}`);
      await adoptUnknownAccountRows(phoneNumber);
      emit('wa:connected', { phone: phoneNumber, name: sock.user?.name });

      // Immediately refresh LID→phone map so group msg senders resolve on reconnect
      await loadLidPhoneMapFromDB();

      // After connect: scan ALL groups and populate LID→phone in wa_contacts
      // Delay 60s to let WhatsApp settle before making group metadata requests
      setTimeout(() => {
        if (generation === socketGeneration) syncAllGroupParticipants();
      }, 60000);
    }

    if (connection === 'close') {
      isConnected = false;
      currentState = 'DISCONNECTED';
      emit('wa:disconnected');

      const code = (lastDisconnect?.error)?.output?.statusCode || (lastDisconnect?.error)?.code;
      const reason = lastDisconnect?.error?.message || 'unknown';
      console.warn(`[WA] Connection closed. Code: ${code}, Reason: ${reason}`);
      if (lastDisconnect?.error) {
        console.error('[WA] Full Disconnect Error:', JSON.stringify(lastDisconnect.error, null, 2));
      }

      if (code === DisconnectReason.loggedOut) {
        // User logged out - clear session and restart
        console.log('[WA] Logged out - clearing session');
        clearSession();
        reconnectAttempts = 0; // Reset attempts for a fresh start
        if (allowQrGeneration) scheduleReconnect('logged out');
      } else if (code === 408) {
        // QR expired — restart to generate a fresh QR
        console.log('[WA] QR timeout — restarting to generate fresh QR');
        if (allowQrGeneration) scheduleReconnect('qr timeout');
      } else if (code === 515) {
        // Connection replaced (scanned QR again or on another device)
        // This is NORMAL when re-scanning QR - just reconnect with new session
        console.log('[WA] Connection replaced - reconnecting with new session');
        reconnectAttempts = 0;
        scheduleReconnect('connection replaced');
      } else if (code === 401) {
        // Unauthorized - session invalid
        console.log('[WA] Unauthorized - clearing session');
        clearSession();
        reconnectAttempts = 0;
        if (allowQrGeneration) scheduleReconnect('unauthorized');
      } else if (code === 500 || code === 503 || !code) {
        // Server error or network issue - retry with exponential backoff
        scheduleReconnect('server error or network issue');
      } else {
        // Unknown error - log and don't reconnect automatically
        console.log('[WA] Unknown disconnect code:', code, '- NOT auto-reconnecting');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── CONTACTS SYNC ──────────────────────────────────────────────────────────────────────
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

  // ── HISTORY SYNC ───────────────────────────────────────────────────────────────────────
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    console.log(`[WA] History chunk — chats=${chats.length} contacts=${contacts?.length || 0} messages=${messages.length} isLatest=${isLatest}`);

    // 1. Save contacts FIRST (needed for name resolution)
    if (contacts?.length) {
      for (const c of contacts) await saveContact(c);
    }

    // 2. Save chats with resolved names
    for (const chat of chats) {
      const isGroup = chat.id.endsWith('@g.us');
      const name = isGroup
        ? (chat.name || null)
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
        const name = isGroup ? getContactName(jid, null) : getContactName(jid, msg.key.fromMe ? null : msg.pushName);
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

  // ── CHAT LIST UPDATES ──────────────────────────────────────────────────────────────────
  // Track whether we already have data so reconnect chats.upsert doesn't cause duplicate renders
  let chatsUpsertDebounce = null;
  let chatsBatchCount = 0;
  sock.ev.on('chats.upsert', async (chats) => {
    chatsBatchCount++;
    for (const chat of chats) {
      const isGroup = chat.id.endsWith('@g.us');
      const name = isGroup
        ? (chat.name || null)
        : getContactName(chat.id, chat.name);
      await saveChat(chat.id, name, '', toDate(chat.conversationTimestamp), 0, isGroup);
    }
    // Debounce: wait 3s after the last batch before refreshing the UI.
    // On FIRST connect: suppress — messaging-history.set isLatest=true fires wa:sync_complete instead.
    // On RECONNECT: Baileys replays chats, data already in DB → emit once after batch settles.
    if (chatsUpsertDebounce) clearTimeout(chatsUpsertDebounce);
    chatsUpsertDebounce = setTimeout(() => {
      const batches = chatsBatchCount;
      chatsBatchCount = 0;
      chatsUpsertDebounce = null;
      if (isReconnect) {
        console.log(`[WA] chats.upsert settled (${batches} batches, reconnect) — emitting wa:chats_updated`);
        emit('wa:chats_updated', {});
      } else {
        console.log(`[WA] chats.upsert settled (${batches} batches, first connect) — skipping wa:chats_updated (wa:sync_complete handles UI refresh)`);
      }
    }, 3000);
  });

  // ── REAL-TIME MESSAGES ───────────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // Cache for media download
      if (msg.key && msg.key.id && msg.message) {
        msgCache.set(msg.key.id, msg);
        if (msgCache.size > MAX_CACHE) msgCache.delete(msgCache.keys().next().value);

        // Auto-save media to disk so it's available even after cache expires
        const mtype = getContentType(msg.message);
        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(mtype)) {
          try {
            const buf = await downloadMediaMessage(msg, 'buffer', {});
            const mediaDir = path.join(__dirname, '../wa_media');
            if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
            const ext = mtype === 'imageMessage' ? 'jpg' : mtype === 'videoMessage' ? 'mp4' : mtype === 'audioMessage' ? 'ogg' : mtype === 'stickerMessage' ? 'webp' : 'bin';
            const docMsg = msg.message.documentMessage;
            const fname = docMsg?.fileName || `${msg.key.id}.${ext}`;
            const savedName = msg.key.id + '_' + fname;
            fs.writeFileSync(path.join(mediaDir, savedName), buf);
            msg.mediaPath = savedName;
          } catch (e) {
            console.warn('[WA] Auto-save media failed:', e.message);
          }
        }
      }
      if (!isRealMessage(msg)) continue;
      const rawJid = msg.key?.remoteJid || '';
      let jid = rawJid.includes(':') ? (rawJid.split(':')[0] + '@' + rawJid.split('@')[1]) : rawJid;
      if (!jid || jid === 'status@broadcast') continue;

      console.log(`[WA] Incoming message from ${jid}: ${getBody(msg).substring(0, 30)}`);

      const saved = await saveMessage(msg);
      if (!saved) continue;

      const isGroup = jid.endsWith('@g.us');
      const chatName = isGroup
        ? getContactName(jid, null)
        : getContactName(jid, msg.key.fromMe ? null : msg.pushName);

      await saveChat(jid, chatName, saved.body, saved.ts, msg.key.fromMe ? 0 : 1, isGroup);

      if (type === 'notify' && isRealMessage(msg)) {
        console.log(`[WA] Emitting message to UI: ${saved.id}`);
        let quotedBody = '';
        let isReply = false;

        try {
          const ctx =
            msg.message?.extendedTextMessage?.contextInfo ||
            msg.message?.imageMessage?.contextInfo ||
            msg.message?.videoMessage?.contextInfo ||
            msg.message?.documentMessage?.contextInfo ||
            msg.message?.stickerMessage?.contextInfo ||
            msg.message?.audioMessage?.contextInfo;

          if (ctx?.stanzaId) {
            isReply = true;
          }

          const quotedMsg = ctx?.quotedMessage;

          if (quotedMsg) {
            quotedBody =
              quotedMsg.conversation ||
              quotedMsg.extendedTextMessage?.text ||
              quotedMsg.imageMessage?.caption ||
              quotedMsg.videoMessage?.caption ||
              quotedMsg.documentMessage?.fileName ||
              (quotedMsg.stickerMessage ? '[Sticker]' : null) ||
              quotedMsg.audioMessage?.caption ||
              '[Media]';
          }
        } catch (e) {
          console.warn('[WA] Reply parse failed:', e.message);
        }

        emit('wa:message', {
          id: saved.id,
          chatId: jid,
          fromMe: saved.fromMe,
          sender: saved.sender,
          senderName: saved.senderName,
          body: saved.body,
          type: saved.type,
          ts: saved.ts,
          mediaPath: saved.mediaPath,

          quotedBody: saved.quotedBody,
          isReply: saved.isReply,
          replyToMsgId: saved.replyToMsgId,

          chatName,
        });
      }
    }
  });

  // ── MESSAGE STATUS ──────────────────────────────────────────────────────────────────
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.status) {
        const statusMap = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'played' };
        const status = statusMap[update.status] || 'sent';
        const accPhone = phoneNumber || 'unknown';
        await pool.query(
          `UPDATE wa_messages SET status=$1 WHERE id=$2 AND chat_id=$3 AND account_phone=$4`,
          [status, key.id, key.remoteJid, accPhone]
        );
        emit('wa:status', { id: key.id, status });
      }
    }
  });

  // ── GROUP METADATA ──────────────────────────────────────────────────────────────────
  sock.ev.on('groups.upsert', async (groups) => {
    for (const g of groups) {
      const accPhone = phoneNumber || 'unknown';
      await pool.query(
        `UPDATE wa_chats SET name=COALESCE($1, name) WHERE id=$2 AND account_phone=$3`,
        [g.subject || null, g.id, accPhone]
      );
      contactsStore[g.id] = { name: g.subject };
    }
  });

  sock.ev.on('groups.update', async (updates) => {
    for (const g of updates) {
      if (g.subject) {
        const accPhone = phoneNumber || 'unknown';
        await pool.query(`UPDATE wa_chats SET name=$1 WHERE id=$2 AND account_phone=$3`, [g.subject, g.id, accPhone]);
        contactsStore[g.id] = { name: g.subject };
      }
    }
  });

  return sock;
}

// ── UPDATE CHAT NAMES AFTER CONTACTS SYNC ───────────────────────────────────────────
async function updateChatNames() {
  try {
    // Step 1: Update names from contactsStore (in-memory)
    const accPhone = phoneNumber || 'unknown';
    const chats = await pool.query(`SELECT id, phone, name, is_group FROM wa_chats WHERE account_phone=$1`, [accPhone]);
    let updated = 0;
    for (const chat of chats.rows) {
      if (chat.is_group) continue;
      const rawPhone = chat.id.split('@')[0].split(':')[0];
      const resolvedName = getContactName(chat.id, null);
      const displayPhone = rawPhone.startsWith('91') && rawPhone.length === 12
        ? '+91 ' + rawPhone.slice(2, 7) + ' ' + rawPhone.slice(7)
        : '+' + rawPhone;
      if (resolvedName && resolvedName !== ('+' + rawPhone) && resolvedName !== rawPhone) {
        await pool.query(`UPDATE wa_chats SET name=$1, phone=$2 WHERE id=$3 AND account_phone=$4`, [resolvedName, displayPhone, chat.id, accPhone]);
        updated++;
      } else if (!chat.phone || chat.phone !== displayPhone) {
        await pool.query(`UPDATE wa_chats SET phone=$1 WHERE id=$2 AND account_phone=$3`, [displayPhone, chat.id, accPhone]);
      }
    }

    // Step 2: For @lid chats, use wa_contacts.phone (same data as group members panel)
    await pool.query(`
      UPDATE wa_chats
      SET phone = CASE
        WHEN wc.phone LIKE '91%' AND length(wc.phone) = 12
          THEN '+91 ' || substring(wc.phone, 3, 5) || ' ' || substring(wc.phone, 8, 5)
        WHEN wc.phone IS NOT NULL AND wc.phone != ''
          THEN '+' || wc.phone
        ELSE wa_chats.phone
      END,
      name = CASE
        WHEN (wc.name IS NOT NULL AND wc.name != '' AND wc.name NOT LIKE '+%')
          THEN wc.name
        WHEN (wc.notify IS NOT NULL AND wc.notify != '')
          THEN wc.notify
        ELSE wa_chats.name
      END
      FROM wa_contacts wc
      WHERE wa_chats.id = wc.jid
        AND wa_chats.account_phone = $1
        AND wc.account_phone = $1
        AND wa_chats.id LIKE '%@lid'
        AND wc.phone IS NOT NULL
        AND wc.phone != ''
    `, [accPhone]);

    console.log('[WA] Updated ' + updated + ' chat names');
  } catch (err) {
    console.error('[WA] updateChatNames error:', err.message);
  }
}

// ── SYNC ALL GROUP PARTICIPANTS → populate LID→phone in wa_contacts ────────
async function syncAllGroupParticipants() {
  if (!sock || !isConnected) return;
  const now = Date.now();
  if (groupParticipantSyncing) {
    console.log('[WA] Group participant sync skipped: already running');
    return;
  }
  if (lastGroupParticipantSyncAt && (now - lastGroupParticipantSyncAt) < GROUP_PARTICIPANT_SYNC_INTERVAL_MS) {
    console.log('[WA] Group participant sync skipped: recently completed');
    return;
  }
  groupParticipantSyncing = true;
  try {
    const accPhone = phoneNumber || 'unknown';
    const groups = await pool.query(`SELECT id FROM wa_chats WHERE is_group = true AND account_phone=$1`, [accPhone]);
    if (groups.rows.length === 0) return;
    console.log(`[WA] Syncing participants for ${groups.rows.length} groups...`);
    let total = 0;
    for (const group of groups.rows) {
      if (!isConnected) break; // Stop sync if disconnected
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const meta = await sock.groupMetadata(group.id);
        for (const p of meta.participants) {
          if (!p.id || !p.id.endsWith('@lid')) continue;
          if (!p.phoneNumber) continue;
          const pNum = typeof p.phoneNumber === 'string' ? p.phoneNumber : (p.phoneNumber?.jid || '');
          const rawPhone = pNum.replace(/\D/g, '');
          if (!rawPhone || rawPhone.length < 7) continue;
          await pool.query(`
            INSERT INTO wa_contacts (jid, account_phone, name, phone)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (jid, account_phone) DO UPDATE SET
              phone = EXCLUDED.phone,
              name  = COALESCE(EXCLUDED.name, wa_contacts.name),
              updated_at = NOW()
          `, [p.id, accPhone, null, rawPhone]);
          total++;
        }
      } catch (_) { }
    }
    console.log(`[WA] ✅ Group participant sync done — ${total} LID→phone entries saved`);
    lastGroupParticipantSyncAt = Date.now();
    emit('wa:participants_synced', { total });
  } catch (err) {
    console.error('[WA] syncAllGroupParticipants error:', err.message);
  } finally {
    groupParticipantSyncing = false;
  }
}

// ── CLEAR SESSION ────────────────────────────────────────────────────────────────────
function clearSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.readdirSync(AUTH_DIR).forEach(f => fs.unlinkSync(path.join(AUTH_DIR, f)));
      console.log('[WA] Session cleared');
    }
  } catch (e) { console.warn('[WA] clearSession error:', e.message); }
}

// ── SEND MESSAGE ─────────────────────────────────────────────────────────────────────
async function adoptUnknownAccountRows(accPhone) {
  if (!accPhone || accPhone === 'unknown') return;
  try {
    await pool.query(`
      UPDATE wa_contacts old
      SET account_phone = $1
      WHERE old.account_phone = 'unknown'
        AND NOT EXISTS (
          SELECT 1 FROM wa_contacts existing
          WHERE existing.jid = old.jid
            AND existing.account_phone = $1
        )
    `, [accPhone]);
    await pool.query(`
      UPDATE wa_chats old
      SET account_phone = $1
      WHERE old.account_phone = 'unknown'
        AND NOT EXISTS (
          SELECT 1 FROM wa_chats existing
          WHERE existing.id = old.id
            AND existing.account_phone = $1
        )
    `, [accPhone]);
    await pool.query(`
      UPDATE wa_messages old
      SET account_phone = $1
      WHERE old.account_phone = 'unknown'
        AND NOT EXISTS (
          SELECT 1 FROM wa_messages existing
          WHERE existing.id = old.id
            AND existing.chat_id = old.chat_id
            AND existing.account_phone = $1
        )
    `, [accPhone]);
    console.log('[WA] Adopted legacy unknown WhatsApp rows for account', accPhone);
  } catch (e) {
    console.warn('[WA] Legacy account adoption skipped:', e.message);
  }
}

async function sendMessage(jid, text, quotedMsgId) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const formattedJid = formatJid(jid);
  const accPhone = phoneNumber || 'unknown';

  let sendContent = { text };
  let sendOptions = {};
  let quotedBody = null;

  if (quotedMsgId) {
    try {
      const res = await pool.query(
        `SELECT body, media_path, from_me, sender FROM wa_messages WHERE id=$1 AND chat_id=$2 AND account_phone=$3`,
        [quotedMsgId, formattedJid, accPhone]
      );
      if (res.rows[0]) {
        quotedBody =
          res.rows[0].body ||
          (res.rows[0].media_path
            ? res.rows[0].media_path.split('_').slice(1).join('_')
            : '[Media]');
        sendOptions.quoted = {
          key: {
            id: quotedMsgId,
            remoteJid: formattedJid,
            fromMe: res.rows[0].from_me,
            participant: res.rows[0].from_me ? undefined : (res.rows[0].sender || undefined),
          },
          message: { conversation: res.rows[0].body || '' },
        };
      }
    } catch (e) {
      console.warn('[WA] Could not build quoted message:', e.message);
    }
  }

  const result = await sock.sendMessage(formattedJid, sendContent, sendOptions);
  const ts = new Date();
  const savedMsg = {
    id: result.key.id,
    chatId: formattedJid,
    fromMe: true,
    senderName: 'You',
    body: text,
    msgType: 'text',
    timestamp: ts,
    status: 'sent',
    quotedBody,
    replyToMsgId: quotedMsgId || null
  };

  await pool.query(
    `INSERT INTO wa_messages (id, chat_id, account_phone, from_me, sender_name, body, msg_type, timestamp, is_read, status, quoted_body, is_reply, reply_to_msg_id)
     VALUES ($1,$2,$3,true,'You',$4,'text',$5,true,'sent',$6,$7,$8)
     ON CONFLICT (id, chat_id, account_phone) DO NOTHING`,
    [savedMsg.id, formattedJid, accPhone, text, ts, savedMsg.quotedBody, !!quotedMsgId, quotedMsgId || null]
  );
  await saveChat(formattedJid, null, text, ts, 0, formattedJid.endsWith('@g.us'));

  emit('wa:message', savedMsg);
  return result;
}

function safeMediaFilename(filename, fallback) {
  const clean = String(filename || fallback || 'file.bin')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return clean || fallback || 'file.bin';
}

function mediaKindToMessageType(mediaType, mime) {
  const kind = String(mediaType || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  if (kind === 'sticker' || m === 'image/webp' || m === 'image/gif') return 'stickerMessage';
  if (kind === 'image' || m.startsWith('image/')) return 'imageMessage';
  if (kind === 'video' || m.startsWith('video/')) return 'videoMessage';
  return 'documentMessage';
}

function stickerFilename(filename) {
  const base = safeMediaFilename(filename, 'sticker.webp').replace(/\.[^.]+$/, '');
  return `${base || 'sticker'}.webp`;
}

async function prepareStickerMedia(buffer, mimetype, filename) {
  const inputMime = String(mimetype || '').toLowerCase();
  if (inputMime === 'image/webp' || /\.webp$/i.test(filename || '')) {
    return {
      buffer,
      mimetype: 'image/webp',
      filename: stickerFilename(filename),
    };
  }

  const image = getSharp()(buffer, {
    animated: inputMime === 'image/gif' || /\.gif$/i.test(filename || ''),
    pages: -1,
    limitInputPixels: false,
  });

  const converted = await image
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: true,
    })
    .webp({ quality: 80, effort: 4 })
    .toBuffer();

  return {
    buffer: converted,
    mimetype: 'image/webp',
    filename: stickerFilename(filename),
  };
}

async function sendPreparedMedia(formattedJid, msgType, buffer, mimetype, filename, caption, quoted) {
  let content;
  if (msgType === 'imageMessage') {
    content = { image: buffer, mimetype, caption };
  } else if (msgType === 'videoMessage') {
    content = { video: buffer, mimetype, caption };
  } else if (msgType === 'stickerMessage') {
    content = { sticker: buffer, mimetype: mimetype || 'image/webp' };
  } else {
    content = { document: buffer, mimetype, fileName: filename, caption };
  }

  console.log(`[WA] Sending ${msgType} payload structure keys:`, Object.keys(content));
  return sock.sendMessage(formattedJid, content, quoted ? { quoted } : {});
}

async function sendMediaMessage(jid, media, quotedMsgId) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const formattedJid = formatJid(jid);
  const accPhone = phoneNumber || 'unknown';
  const buffer = Buffer.isBuffer(media?.buffer) ? media.buffer : Buffer.from(media?.buffer || '');
  if (!buffer.length) throw new Error('Media file is empty');

  const mimetype = media.mimetype || 'application/octet-stream';
  const msgType = mediaKindToMessageType(media.mediaType, mimetype);
  let finalBuffer = buffer;
  let finalMimetype = mimetype;
  let filename = safeMediaFilename(media.filename, msgType === 'imageMessage' ? 'photo.jpg' : msgType === 'videoMessage' ? 'video.mp4' : msgType === 'stickerMessage' ? 'sticker.webp' : 'document');
  if (msgType === 'stickerMessage') {
    const preparedSticker = await prepareStickerMedia(buffer, mimetype, filename);
    finalBuffer = preparedSticker.buffer;
    finalMimetype = preparedSticker.mimetype;
    filename = preparedSticker.filename;
  }
  const caption = msgType === 'stickerMessage' ? '' : String(media.caption || '').trim();

  let quoted = null;
  if (quotedMsgId) {
    try {
      const res = await pool.query(
        `SELECT body, from_me, sender FROM wa_messages WHERE id=$1 AND chat_id=$2 AND account_phone=$3`,
        [quotedMsgId, formattedJid, accPhone]
      );
      if (res.rows[0]) {
        quoted = {
          key: {
            id: quotedMsgId,
            remoteJid: formattedJid,
            fromMe: !!res.rows[0].from_me,
            participant: res.rows[0].from_me ? undefined : (res.rows[0].sender ? formatJid(res.rows[0].sender) : undefined),
          },
          message: { conversation: res.rows[0].body || '' },
        };
      }
    } catch (e) {
      console.warn('[WA] Could not build quoted media message:', e.message);
    }
  }

  let finalType = msgType;
  let result;
  try {
    // Attempt combined send (Document + Caption in one bubble)
    console.log(`[WA] Attempting combined send of ${finalType} to ${formattedJid} with caption: "${caption || ''}"`);
    result = await sendPreparedMedia(formattedJid, finalType, finalBuffer, finalMimetype, filename, caption, quoted);
    console.log(`[WA] Send successful, ID: ${result?.key?.id}`);
  } catch (err) {
    console.error(`[WA] Combined send failed for ${finalType}:`, err.message);

    // Fallback: If combined fails, try file only to at least deliver the content
    console.warn(`[WA] Falling back to file-only transmission...`);
    try {
      result = await sendPreparedMedia(formattedJid, finalType, finalBuffer, finalMimetype, filename, null, quoted);
      console.log(`[WA] File-only fallback successful, ID: ${result?.key?.id}`);

      // If file-only worked, send caption as separate follow-up
      if (caption) {
        console.log(`[WA] Sending caption as follow-up...`);
        await sendMessage(formattedJid, caption, result?.key?.id);
      }
    } catch (fallbackErr) {
      console.error(`[WA] All transmission attempts failed:`, fallbackErr.message);
      throw fallbackErr;
    }
  }

  const id = result.key.id;
  const ts = new Date();
  const mediaDir = path.join(__dirname, '../wa_media');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  const savedName = id + '_' + filename;
  fs.writeFileSync(path.join(mediaDir, savedName), finalBuffer);

  const body = caption || filename || 'Media Message';

  let quotedBody = null;

  if (quotedMsgId) {
    try {
      const q = await pool.query(
        `SELECT body, media_path FROM wa_messages WHERE id=$1 AND chat_id=$2 AND account_phone=$3`,
        [quotedMsgId, formattedJid, accPhone]
      );

      if (q.rows[0]) {
        quotedBody =
          q.rows[0].body ||
          (q.rows[0].media_path
            ? q.rows[0].media_path.split('_').slice(1).join('_')
            : '[Media]');
      }
    } catch (e) {
      console.warn('[WA] quotedBody fetch failed:', e.message);
    }
  }

  const savedMsg = {
    id,
    chatId: formattedJid,
    fromMe: true,
    senderName: 'You',
    body,
    msgType: finalType,
    timestamp: ts,
    status: 'sent',
    quotedBody,
    replyToMsgId: quotedMsgId || null,
    mediaPath: savedName,
    filename: filename
  };

  await pool.query(
    `INSERT INTO wa_messages (id, chat_id, account_phone, from_me, sender_name, body, msg_type, timestamp, is_read, status, quoted_body, is_reply, reply_to_msg_id, media_path)
     VALUES ($1,$2,$3,true,'You',$4,$5,$6,true,'sent',$7,$8,$9,$10)
     ON CONFLICT (id, chat_id, account_phone) DO NOTHING`,
    [id, formattedJid, accPhone, body, finalType, ts, savedMsg.quotedBody, !!quotedMsgId, quotedMsgId || null, savedName]
  );
  await saveChat(formattedJid, null, body, ts, 0, formattedJid.endsWith('@g.us'));

  emit('wa:message', savedMsg);
  return savedMsg;
}

// ── GROUP METADATA ───────────────────────────────────────────────────────────
async function getGroupMetadata(jid) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const CACHE_TTL = 15 * 60 * 1000;
  const cached = groupMetadataCache.get(jid);
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) return cached.data;

  const meta = await sock.groupMetadata(jid);
  const processedParticipants = meta.participants.map(p => {
    const pJid = p.id;
    const phoneJid = p.phoneNumber || (pJid.endsWith('@lid') ? null : pJid);
    const rawPhone = phoneJid ? phoneJid.split('@')[0].split(':')[0] : '';
    let phoneDisplay = '';
    if (rawPhone && /^\d{7,15}$/.test(rawPhone)) {
      phoneDisplay = rawPhone.startsWith('91') && rawPhone.length === 12
        ? '+91 ' + rawPhone.slice(2, 7) + ' ' + rawPhone.slice(7)
        : '+' + rawPhone;
    }
    const realJid = phoneJid || pJid;
    const stored = contactsStore[realJid] || contactsStore[pJid];
    const displayName = stored?.name || stored?.notify || phoneDisplay || null;
    return { jid: pJid, phone: phoneDisplay, name: displayName, admin: p.admin === 'admin' || p.admin === 'superadmin' };
  });

  const result = { id: meta.id, name: meta.subject, description: meta.desc || '', participants: processedParticipants };
  groupMetadataCache.set(jid, { ts: Date.now(), data: result });
  return result;
}

// ── MEDIA DOWNLOAD ────────────────────────────────────────────────────────────
const msgCache = new Map();
const MAX_CACHE = 500;

async function downloadMedia(msgId) {
  const mediaDir = path.join(__dirname, '../wa_media');
  if (fs.existsSync(mediaDir)) {
    const files = fs.readdirSync(mediaDir).filter(f => f.startsWith(msgId + '_'));
    if (files.length > 0) {
      const fpath = path.join(mediaDir, files[0]);
      const buffer = fs.readFileSync(fpath);
      const ext = path.extname(files[0]).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.bin': 'application/octet-stream',
        '.ogg': 'audio/ogg', '.webp': 'image/webp'
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const filename = files[0].replace(msgId + '_', '');
      return { buffer, mime, filename };
    }
  }
  const cached = msgCache.get(msgId);
  if (!cached) throw new Error('Message not in cache.');
  const buffer = await downloadMediaMessage(
    cached,
    'buffer',
    {},
    {
      reuploadRequest: sock.updateMediaMessage
    }
  );
  const type = getContentType(cached.message);
  const docMsg = cached.message.documentMessage;
  const stickerMsg = cached.message.stickerMessage;
  const filename = docMsg?.fileName || (type === 'imageMessage' ? 'image.jpg' : type === 'videoMessage' ? 'video.mp4' : type === 'stickerMessage' ? 'sticker.webp' : 'file.bin');
  const mime = docMsg?.mimetype || stickerMsg?.mimetype || (type === 'stickerMessage' ? 'image/webp' : 'application/octet-stream');
  return { buffer, mime, filename };
}

// ── LOGOUT ────────────────────────────────────────────────────────────────────
async function logout() {
  console.log('[WA] Logging out...');
  allowQrGeneration = false;
  currentState = 'DISCONNECTED';
  if (sock) {
    try { await sock.logout(); } catch (e) { console.warn('[WA] Logout error:', e.message); }
    sock = null;
    isConnected = false;
    qrString = null;
    phoneNumber = null;
    reconnectAttempts = 0;
  }
  clearSession();
}

// ── STATUS ─────────────────────────────────────────────────────────────────────
function getStatus() {
  return {
    connected: isConnected,
    phone: phoneNumber,
    name: sock?.user?.name || null,
    hasQR: !!qrString,
    hasSession: hasSavedSession(),
    state: currentState
  };
}

async function getQR() {
  if (!qrString) return null;
  return qrcode.toDataURL(qrString);
}

async function requestQR() {
  if (!isConnected && !qrString) {
    await startWA({ allowQR: true });
  }
  const startedAt = Date.now();
  while (!qrString && !isConnected && Date.now() - startedAt < 8000) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return getQR();
}

function getConnectedPhone() {
  if (!isConnected) return null;
  return phoneNumber;
}

// ── IMPORT ────────────────────────────────────────────────────────────────────
async function importExportedChat(chatText, chatJid, mediaFiles, clearOld) {
  if (!chatJid) throw new Error("A valid chat must be selected.");
  await ensureTables();
  const accPhone = phoneNumber || 'unknown';
  const existing = await pool.query(`SELECT id, name FROM wa_chats WHERE id=$1 AND account_phone=$2`, [chatJid, accPhone]);
  if (existing.rows.length === 0) throw new Error("Chat not found.");
  const displayChatName = existing.rows[0].name;

  if (clearOld) await pool.query(`DELETE FROM wa_messages WHERE chat_id=$1 AND account_phone=$2`, [chatJid, accPhone]);

  const mediaDir = path.join(__dirname, '../wa_media');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

  const mediaSavedMap = {};
  if (Array.isArray(mediaFiles)) {
    for (const mf of mediaFiles) {
      if (!mf.filename || !mf.base64) continue;
      const buf = Buffer.from(mf.base64, 'base64');
      const fakeMsgId = 'import_' + Buffer.from(mf.filename).toString('base64').substring(0, 24);
      fs.writeFileSync(path.join(mediaDir, fakeMsgId + '_' + mf.filename), buf);
      mediaSavedMap[mf.filename.toLowerCase()] = { msgId: fakeMsgId };
    }
  }

  const lines = chatText.split('\n');
  const androidRe = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?[\s\u202F\u00A0]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202F\u00A0]*(am|pm|AM|PM)?[\s\u202F\u00A0]*[-–][\s\u202F\u00A0]*(.+?):\s([\s\S]*)$/;
  const iosRe = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?[\s\u202F\u00A0]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202F\u00A0]*(am|pm|AM|PM)?\][\s\u202F\u00A0]*(.+?):\s([\s\S]*)$/;
  const mediaAttachedRe = /^(.+?\.(jpg|jpeg|png|gif|mp4|mp3|opus|ogg|pdf|docx?|xlsx?|pptx?|zip|aac|m4a|webp|sticker))(?:\s*\(file attached\))?(?:\s+([\s\S]*))?$/i;

  let imported = 0;
  let lastTs = new Date();
  let pendingMsg = null;

  const flush = async () => {
    if (!pendingMsg) return;
    const { ts, senderName, body, msgType, linkedMediaPath } = pendingMsg;
    const cleanBody = body.replace(/^\u200e|\u200f/g, '').trim();
    if (!cleanBody || cleanBody.includes('omitted')) { pendingMsg = null; return; }

    const msgId = 'import_' + Buffer.from(ts.toISOString() + senderName + cleanBody.substring(0, 20)).toString('base64').substring(0, 32);
    const isFromMe = (senderName === 'You');

    await pool.query(`
      INSERT INTO wa_messages (id, chat_id, account_phone, from_me, sender_name, body, msg_type, timestamp, is_read, status, media_path)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,'read',$9)
      ON CONFLICT (id, chat_id, account_phone) DO NOTHING
    `, [msgId, chatJid, accPhone, isFromMe, isFromMe ? 'You' : senderName, cleanBody, msgType, ts, linkedMediaPath]);
    imported++;
    lastTs = ts;
    pendingMsg = null;
  };

  for (const line of lines) {
    const cleanLine = line.replace(/^\u200e|\u200f/g, '').trim();
    const match = cleanLine.match(androidRe) || cleanLine.match(iosRe);
    if (match) {
      await flush();
      let [, day, month, year, hh, mm, ss, ampm, senderName, body] = match;
      let hour = parseInt(hh, 10);
      if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;
      const yr = year.length === 2 ? '20' + year : year;
      const ts = new Date(`${yr}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${mm.padStart(2, '0')}:00+05:30`);

      let msgType = 'text';
      let linkedMediaPath = null;
      const mediaMatch = body.match(mediaAttachedRe);
      if (mediaMatch) {
        const lookup = mediaMatch[1].trim().toLowerCase();
        if (mediaSavedMap[lookup]) {
          linkedMediaPath = mediaSavedMap[lookup].msgId + '_' + mediaMatch[1].trim();
          msgType = 'documentMessage'; // simplified
        }
      }
      pendingMsg = { ts, senderName, body, msgType, linkedMediaPath };
    } else if (pendingMsg) {
      pendingMsg.body += '\n' + line;
    }
  }
  await flush();
  await pool.query(`UPDATE wa_chats SET last_time=$1, imported_last_ts=GREATEST(imported_last_ts, $1) WHERE id=$2 AND account_phone=$3`, [lastTs, chatJid, accPhone]);
  importedLastTsMap[chatJid] = new Date(lastTs).getTime();
  return { imported, chatJid, chatName: displayChatName };
}

module.exports = { startWA, sendMessage, sendMediaMessage, logout, getStatus, getQR, requestQR, setIO, getGroupMetadata, downloadMedia, msgCache, importExportedChat, getConnectedPhone };


