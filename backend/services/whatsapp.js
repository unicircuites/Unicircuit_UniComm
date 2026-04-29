/**
 * WhatsApp Service — Baileys (whatsapp-web.js style)
 * QR scan → connect → real-time messages → PostgreSQL storage
 */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidDecode,
  proto,
  getContentType,
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode');
const path   = require('path');
const pool   = require('../db/pool');

// ── STATE ──────────────────────────────────────────────────────────────────
let sock         = null;
let qrString     = null;
let isConnected  = false;
let phoneNumber  = null;
let io           = null;  // Socket.IO instance injected from server.js

const AUTH_DIR = path.join(__dirname, '../wa_auth');

// ── INJECT SOCKET.IO ───────────────────────────────────────────────────────
function setIO(socketIO) { io = socketIO; }

// ── EMIT TO ALL CLIENTS ────────────────────────────────────────────────────
function emit(event, data) {
  if (io) io.emit(event, data);
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
      avatar_url   TEXT,
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
      media_url    TEXT,
      timestamp    TIMESTAMPTZ,
      is_read      BOOLEAN DEFAULT FALSE,
      status       VARCHAR(20) DEFAULT 'sent',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── SAVE CHAT TO DB ────────────────────────────────────────────────────────
async function saveChat(jid, name, lastMsg, lastTime, unread, isGroup) {
  const phone = jid.split('@')[0];
  // Safely parse timestamp
  let ts = new Date();
  try {
    if (lastTime) {
      const d = new Date(lastTime);
      if (!isNaN(d.getTime())) ts = d;
    }
  } catch (_) {}

  await pool.query(`
    INSERT INTO wa_chats (id, name, phone, last_message, last_time, unread, is_group)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO UPDATE SET
      name         = EXCLUDED.name,
      last_message = EXCLUDED.last_message,
      last_time    = EXCLUDED.last_time,
      unread       = wa_chats.unread + EXCLUDED.unread,
      updated_at   = NOW()
  `, [jid, name || phone, lastMsg || '', ts, unread || 0, isGroup || false, phone]);
}

// ── SAVE MESSAGE TO DB ─────────────────────────────────────────────────────
async function saveMessage(msg) {
  try {
    const jid      = msg.key.remoteJid;
    const id       = msg.key.id;
    const fromMe   = msg.key.fromMe || false;
    const sender   = fromMe ? 'me' : (msg.key.participant || jid);
    const ts       = new Date(Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000);
    const type     = getContentType(msg.message) || 'text';

    let body = '';
    if (type === 'conversation')          body = msg.message.conversation;
    else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage?.text || '';
    else if (type === 'imageMessage')     body = msg.message.imageMessage?.caption || '[Image]';
    else if (type === 'videoMessage')     body = msg.message.videoMessage?.caption || '[Video]';
    else if (type === 'audioMessage')     body = '[Voice message]';
    else if (type === 'documentMessage')  body = `[Document: ${msg.message.documentMessage?.fileName || 'file'}]`;
    else if (type === 'stickerMessage')   body = '[Sticker]';
    else body = `[${type}]`;

    await pool.query(`
      INSERT INTO wa_messages (id, chat_id, from_me, sender, body, msg_type, timestamp, is_read)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO NOTHING
    `, [id, jid, fromMe, sender, body, type, ts, fromMe]);

    return { id, jid, fromMe, sender, body, type, ts };
  } catch (err) {
    console.error('[WA] saveMessage error:', err.message);
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
    syncFullHistory:   false,   // false = faster connect, recent chats only
    shouldSyncHistoryMessage: () => true,
    getMessage: async (key) => {
      const res = await pool.query(`SELECT body FROM wa_messages WHERE id=$1`, [key.id]);
      return res.rows[0] ? { conversation: res.rows[0].body } : { conversation: '' };
    },
  });

  // ── QR CODE ──────────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString    = qr;
      isConnected = false;
      console.log('[WA] QR code generated — scan with WhatsApp');
      const qrDataUrl = await qrcode.toDataURL(qr);
      emit('wa:qr', { qr: qrDataUrl });
    }

    if (connection === 'open') {
      isConnected = true;
      qrString    = null;
      phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id;
      console.log('[WA] ✅ Connected as', phoneNumber);
      emit('wa:connected', { phone: phoneNumber, name: sock.user?.name });

      // Sync recent chats on connect
      syncRecentChats();
    }

    if (connection === 'close') {
      isConnected = false;
      const code  = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[WA] Disconnected. Code:', code, '| Reconnect:', shouldReconnect);
      emit('wa:disconnected', { code });
      if (shouldReconnect) {
        setTimeout(startWA, 3000);
      }
    }
  });

  // ── SAVE CREDENTIALS ─────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── INCOMING MESSAGES ─────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (jid === 'status@broadcast') continue;

      const saved = await saveMessage(msg);
      if (!saved) continue;

      // Update chat record
      const name = msg.pushName || jid.split('@')[0];
      await saveChat(jid, name, saved.body, saved.ts, msg.key.fromMe ? 0 : 1, jid.endsWith('@g.us'));

      // Emit to dashboard in real-time
      emit('wa:message', {
        id:      saved.id,
        chatId:  jid,
        fromMe:  saved.fromMe,
        sender:  saved.sender,
        body:    saved.body,
        type:    saved.type,
        ts:      saved.ts,
        name,
      });
    }
  });

  // ── MESSAGE STATUS UPDATES ────────────────────────────────────────────────
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

  // ── CHAT UPDATES ──────────────────────────────────────────────────────────
  sock.ev.on('chats.upsert', async (chats) => {
    for (const chat of chats) {
      // conversationTimestamp is Unix seconds (number) from Baileys
      let ts = new Date();
      if (chat.conversationTimestamp) {
        const num = typeof chat.conversationTimestamp === 'object'
          ? chat.conversationTimestamp.low || chat.conversationTimestamp.toNumber?.() || Date.now()/1000
          : Number(chat.conversationTimestamp);
        if (!isNaN(num)) ts = new Date(num * 1000);
      }
      await saveChat(
        chat.id,
        chat.name || chat.id.split('@')[0],
        chat.lastMessage?.message?.conversation || '',
        ts,
        chat.unreadCount || 0,
        chat.id.endsWith('@g.us')
      );
    }
    emit('wa:chats_updated', {});
  });

  return sock;
}

// ── SYNC RECENT CHATS ─────────────────────────────────────────────────────
async function syncRecentChats() {
  try {
    console.log('[WA] Syncing recent chats...');
    emit('wa:syncing', { status: 'Syncing chats...' });
    // Baileys auto-syncs via chats.upsert event
    // This is just a status notification
    setTimeout(() => emit('wa:syncing', { status: 'done' }), 5000);
  } catch (err) {
    console.error('[WA] Sync error:', err.message);
  }
}

// ── SEND MESSAGE ───────────────────────────────────────────────────────────
async function sendMessage(jid, text) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');

  // Ensure proper JID format
  const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;

  const result = await sock.sendMessage(formattedJid, { text });

  // Save to DB
  const ts = new Date();
  await pool.query(`
    INSERT INTO wa_messages (id, chat_id, from_me, sender, body, msg_type, timestamp, is_read, status)
    VALUES ($1,$2,true,'me',$3,'text',$4,true,'sent')
    ON CONFLICT (id) DO NOTHING
  `, [result.key.id, formattedJid, text, ts]);

  await saveChat(formattedJid, null, text, ts, 0, false);

  return result;
}

// ── LOGOUT ────────────────────────────────────────────────────────────────
async function logout() {
  if (sock) {
    await sock.logout();
    sock        = null;
    isConnected = false;
    qrString    = null;
  }
}

// ── STATUS ────────────────────────────────────────────────────────────────
function getStatus() {
  return {
    connected:   isConnected,
    phone:       phoneNumber,
    name:        sock?.user?.name || null,
    hasQR:       !!qrString,
  };
}

async function getQR() {
  if (!qrString) return null;
  return qrcode.toDataURL(qrString);
}

module.exports = { startWA, sendMessage, logout, getStatus, getQR, setIO };
