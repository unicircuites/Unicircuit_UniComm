/**
 * WhatsApp Service — Baileys
 * Deep logging enabled for debugging sync issues
 */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode');
const path   = require('path');
const pool   = require('../db/pool');

// ── STATE ──────────────────────────────────────────────────────────────────
let sock        = null;
let qrString    = null;
let isConnected = false;
let phoneNumber = null;
let io          = null;

const AUTH_DIR = path.join(__dirname, '../wa_auth');

function setIO(socketIO) { io = socketIO; }

function emit(event, data) {
  if (io) io.emit(event, data);
  console.log(`[WA-EMIT] ${event}:`, JSON.stringify(data).substring(0, 120));
}

// ── SAFE TIMESTAMP ─────────────────────────────────────────────────────────
function toDate(ts) {
  if (!ts) return new Date();
  try {
    let secs;
    if (typeof ts === 'object' && ts !== null && typeof ts.toNumber === 'function') {
      secs = ts.toNumber();
    } else if (typeof ts === 'object' && ts !== null && ts.low !== undefined) {
      secs = ts.low + (ts.high || 0) * 4294967296;
    } else {
      secs = Number(ts);
    }
    if (!secs || isNaN(secs) || secs < 1000000 || secs > 9999999999) {
      console.warn('[WA-TS] Invalid timestamp value:', ts, '→ using NOW');
      return new Date();
    }
    return new Date(secs * 1000);
  } catch (e) {
    console.warn('[WA-TS] toDate error:', e.message, 'ts=', ts);
    return new Date();
  }
}

// ── ENSURE DB TABLES ───────────────────────────────────────────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_chats (
      id           VARCHAR(100) PRIMARY KEY,
      name         VARCHAR(200),
      phone        VARCHAR(50),
      last_message TEXT,
      last_time    TIMESTAMPTZ,
      unread       INT DEFAULT 0,
      is_group     BOOLEAN DEFAULT FALSE,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id           VARCHAR(200) PRIMARY KEY,
      chat_id      VARCHAR(100) NOT NULL,
      from_me      BOOLEAN DEFAULT FALSE,
      sender       VARCHAR(100),
      body         TEXT,
      msg_type     VARCHAR(30) DEFAULT 'text',
      timestamp    TIMESTAMPTZ,
      is_read      BOOLEAN DEFAULT FALSE,
      status       VARCHAR(20) DEFAULT 'sent',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[WA-DB] Tables ready');
}

// ── SAVE CHAT ──────────────────────────────────────────────────────────────
async function saveChat(jid, name, lastMsg, lastTime, unread, isGroup) {
  const phone = jid.split('@')[0];
  const ts    = lastTime instanceof Date ? lastTime : toDate(lastTime);
  console.log(`[WA-DB] saveChat jid=${jid} name=${name} ts=${ts.toISOString()} unread=${unread}`);
  try {
    await pool.query(`
      INSERT INTO wa_chats (id, name, phone, last_message, last_time, unread, is_group)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET
        name         = EXCLUDED.name,
        last_message = EXCLUDED.last_message,
        last_time    = EXCLUDED.last_time,
        unread       = wa_chats.unread + EXCLUDED.unread,
        updated_at   = NOW()
    `, [jid, name || phone, phone, lastMsg || '', ts, unread || 0, isGroup || false]);
    console.log(`[WA-DB] ✅ Chat saved: ${jid}`);
  } catch (err) {
    console.error(`[WA-DB] ❌ saveChat error for ${jid}:`, err.message);
  }
}

// ── SAVE MESSAGE ───────────────────────────────────────────────────────────
async function saveMessage(msg) {
  try {
    const jid    = msg.key.remoteJid;
    const id     = msg.key.id;
    const fromMe = msg.key.fromMe || false;
    const sender = fromMe ? 'me' : (msg.key.participant || jid);
    const ts     = toDate(msg.messageTimestamp);
    const type   = getContentType(msg.message) || 'text';

    let body = '';
    if (type === 'conversation')             body = msg.message.conversation || '';
    else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage?.text || '';
    else if (type === 'imageMessage')        body = msg.message.imageMessage?.caption || '[Image]';
    else if (type === 'videoMessage')        body = msg.message.videoMessage?.caption || '[Video]';
    else if (type === 'audioMessage')        body = '[Voice message]';
    else if (type === 'documentMessage')     body = `[Document: ${msg.message.documentMessage?.fileName || 'file'}]`;
    else if (type === 'stickerMessage')      body = '[Sticker]';
    else                                     body = `[${type}]`;

    console.log(`[WA-MSG] id=${id} jid=${jid} fromMe=${fromMe} type=${type} ts=${ts.toISOString()} body="${body.substring(0,50)}"`);

    await pool.query(`
      INSERT INTO wa_messages (id, chat_id, from_me, sender, body, msg_type, timestamp, is_read)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO NOTHING
    `, [id, jid, fromMe, sender, body, type, ts, fromMe]);

    console.log(`[WA-DB] ✅ Message saved: ${id}`);
    return { id, jid, fromMe, sender, body, type, ts };
  } catch (err) {
    console.error('[WA-DB] ❌ saveMessage error:', err.message);
    return null;
  }
}

// ── START WHATSAPP ─────────────────────────────────────────────────────────
async function startWA() {
  await ensureTables();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  console.log('[WA] Starting Baileys v' + version.join('.'));

  sock = makeWASocket({
    version,
    auth:              state,
    printQRInTerminal: false,
    browser:           ['UniComm Pro', 'Chrome', '120.0'],
    syncFullHistory:   false,
    getMessage: async (key) => {
      const res = await pool.query(`SELECT body FROM wa_messages WHERE id=$1`, [key.id]);
      return res.rows[0] ? { conversation: res.rows[0].body } : { conversation: '' };
    },
  });

  // ── CONNECTION UPDATES ────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log('[WA-CONN] update:', JSON.stringify({ connection, hasQR: !!qr, code: lastDisconnect?.error?.output?.statusCode }));

    if (qr) {
      qrString    = qr;
      isConnected = false;
      console.log('[WA-CONN] QR generated — waiting for scan');
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        emit('wa:qr', { qr: qrDataUrl });
      } catch (e) {
        console.error('[WA-CONN] QR toDataURL error:', e.message);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      qrString    = null;
      phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id;
      console.log('[WA-CONN] ✅ Connected as', phoneNumber, 'name:', sock.user?.name);
      emit('wa:connected', { phone: phoneNumber, name: sock.user?.name });
    }

    if (connection === 'close') {
      isConnected = false;
      const code  = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[WA-CONN] ❌ Disconnected. Code:', code, '| Reconnect:', shouldReconnect);
      emit('wa:disconnected', { code });
      if (shouldReconnect) {
        console.log('[WA-CONN] Reconnecting in 3s...');
        setTimeout(startWA, 3000);
      } else {
        console.log('[WA-CONN] Logged out — need fresh QR scan');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── INCOMING MESSAGES ─────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[WA-MSGS] messages.upsert type=${type} count=${messages.length}`);
    for (const msg of messages) {
      if (!msg.message) { console.log('[WA-MSGS] Skipping — no message content'); continue; }
      const jid = msg.key.remoteJid;
      if (jid === 'status@broadcast') { console.log('[WA-MSGS] Skipping status broadcast'); continue; }

      console.log(`[WA-MSGS] Processing: jid=${jid} fromMe=${msg.key.fromMe} pushName=${msg.pushName}`);
      const saved = await saveMessage(msg);
      if (!saved) { console.warn('[WA-MSGS] saveMessage returned null'); continue; }

      const name = msg.pushName || jid.split('@')[0];
      await saveChat(jid, name, saved.body, saved.ts, msg.key.fromMe ? 0 : 1, jid.endsWith('@g.us'));

      emit('wa:message', {
        id: saved.id, chatId: jid, fromMe: saved.fromMe,
        sender: saved.sender, body: saved.body, type: saved.type,
        ts: saved.ts, name,
      });
    }
  });

  // ── CHAT LIST SYNC ────────────────────────────────────────────────────────
  sock.ev.on('chats.upsert', async (chats) => {
    console.log(`[WA-CHATS] chats.upsert count=${chats.length}`);
    for (const chat of chats) {
      console.log(`[WA-CHATS] chat id=${chat.id} name=${chat.name} ts=${chat.conversationTimestamp} unread=${chat.unreadCount}`);
      const ts = toDate(chat.conversationTimestamp);
      await saveChat(
        chat.id,
        chat.name || chat.id.split('@')[0],
        chat.lastMessage?.message?.conversation || '',
        ts,
        chat.unreadCount || 0,
        chat.id.endsWith('@g.us')
      );
    }
    emit('wa:chats_updated', { count: chats.length });
  });

  sock.ev.on('chats.update', async (updates) => {
    console.log(`[WA-CHATS] chats.update count=${updates.length}`);
    for (const update of updates) {
      if (update.unreadCount !== undefined || update.conversationTimestamp) {
        const ts = toDate(update.conversationTimestamp);
        await saveChat(update.id, null, null, ts, update.unreadCount || 0, update.id?.endsWith('@g.us'));
      }
    }
  });

  // ── MESSAGE STATUS ────────────────────────────────────────────────────────
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.status) {
        const statusMap = { 1:'sent', 2:'delivered', 3:'read', 4:'played' };
        const status = statusMap[update.status] || 'sent';
        await pool.query(`UPDATE wa_messages SET status=$1 WHERE id=$2`, [status, key.id]);
        emit('wa:status', { id: key.id, status });
      }
    }
  });

  return sock;
}

// ── SEND MESSAGE ───────────────────────────────────────────────────────────
async function sendMessage(jid, text) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
  console.log(`[WA-SEND] Sending to ${formattedJid}: "${text.substring(0,50)}"`);
  const result = await sock.sendMessage(formattedJid, { text });
  const ts = new Date();
  await pool.query(`
    INSERT INTO wa_messages (id, chat_id, from_me, sender, body, msg_type, timestamp, is_read, status)
    VALUES ($1,$2,true,'me',$3,'text',$4,true,'sent') ON CONFLICT (id) DO NOTHING
  `, [result.key.id, formattedJid, text, ts]);
  await saveChat(formattedJid, null, text, ts, 0, false);
  return result;
}

// ── LOGOUT ────────────────────────────────────────────────────────────────
async function logout() {
  if (sock) {
    console.log('[WA] Logging out...');
    await sock.logout();
    sock = null; isConnected = false; qrString = null;
  }
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
