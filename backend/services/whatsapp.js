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
  ALL_WA_PATCH_NAMES,
  WAMessageStatus,
} = require('@whiskeysockets/baileys');

async function loadBaileys() {
  // Statically required now, no-op
}

const qrcode = require('qrcode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pool = require('../db/pool');

const MEDIA_DIR = process.env.WA_MEDIA_DIR || path.join(__dirname, '../wa_media');

let sharp = null;
function getSharp() {
  if (!sharp) sharp = require('sharp');
  return sharp;
}

// ── STATE ───────────────────────────────────────────────────────────────────────────
let sock = null;
let qrString = null;
let pairingCode = null;
let pairingPhone = null;
let isConnected = false;
let phoneNumber = null; // This will store the REAL phone number
let userJid = null; // This will store the active JID (Phone or LID)
let userLid = null; // This will store the user's LID if available
let io = null;
let currentState = 'INIT'; // INIT | QR_READY | CONNECTED | DISCONNECTED | RECONNECTING
let reconnectAttempts = 0;
let reconnectTimer = null;
let startInProgress = false;
let socketGeneration = 0;
let allowQrGeneration = false;
let groupParticipantSyncing = false;
let lastGroupParticipantSyncAt = 0;
let lastActivityAt = Date.now();
let watchdogTimer = null;
// Reconnect detection: first connect uses sync_complete for UI refresh;
// on reconnect Baileys replays chats.upsert — emit wa:chats_updated once after settle.
let hasConnectedBefore = false;
let isReconnect = false;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAYS = [2000, 5000, 10000, 15000, 30000]; // Progressive delays
const GROUP_PARTICIPANT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const ACTIVITY_BUFFER_LIMIT = 120;
const activityBuffer = [];
const WA_WATCHDOG_ENABLED = String(process.env.WA_WATCHDOG_ENABLED || 'true').toLowerCase() !== 'false';
const WA_WATCHDOG_INTERVAL_MS = Math.max(15000, parseInt(process.env.WA_WATCHDOG_INTERVAL_MS || '45000', 10) || 45000);
const WA_STALE_RESTART_MS = Math.max(60000, parseInt(process.env.WA_STALE_RESTART_MS || '180000', 10) || 180000);
const WA_DYNAMIC_DB_STORE = String(process.env.WA_DYNAMIC_DB_STORE || 'true').toLowerCase() === 'true';

// In-memory contacts store (name lookup)
const contactsStore = {};
const liveChatsStore = new Map();
const liveMessagesStore = new Map();
// In-memory imported chat checkpoint to protect against history sync duplicates
let importedLastTsMap = {};
// In-memory group metadata cache to prevent hangs on large groups
const groupMetadataCache = new Map();
const rawGroupMetadataCache = new Map();

const AUTH_DIR = path.join(__dirname, '../wa_auth');
const SYNC_FULL_HISTORY = String(process.env.WA_SYNC_FULL_HISTORY || 'false').toLowerCase() === 'true';

let historySyncState = {
  totalMessagesLoaded: 0,
  chatMessageCounts: {}
};

function hasSavedSession() {
  return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
}

function normalizeAccountPhone(value) {
  return String(value || '').split('_')[0].split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isAllowedWaNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return false;
  // LID = 15+ digit internal WhatsApp identifier, never a real phone
  if (digits.length >= 15) return false;
  if (digits.length < 7)   return false;
  if (/^0{5,}$/.test(digits)) return false;
  return true; // valid international phone number
}

function normalizeWaPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return isAllowedWaNumber(digits) ? digits : '';
}

function lidLocalPart(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function isLidJid(jid) {
  return String(jid || '').endsWith('@lid');
}

function isNonChatJid(jid) {
  const id = String(jid || '');
  return id === 'status@broadcast' || id.endsWith('@newsletter') || id.endsWith('@broadcast');
}

function resolvedPhoneForLid(jid, rawPhone) {
  const lidLocal = lidLocalPart(jid);
  const digits = normalizeWaPhone(rawPhone);
  if (!digits || digits === lidLocal) return '';
  return digits;
}

function formatDisplayPhone(value) {
  const digits = normalizeWaPhone(value);
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length === 12) {
    return '+91 ' + digits.slice(2, 7) + ' ' + digits.slice(7);
  }
  if (digits.startsWith('0')) return digits;
  return '+' + digits;
}

function normalizeRawJid(rawJid) {
  const raw = String(rawJid || '').trim().toLowerCase();
  if (!raw || !raw.includes('@')) return raw;
  const atIdx = raw.indexOf('@');
  const local = raw.slice(0, atIdx).split(':')[0];
  const rest = raw.slice(atIdx + 1);
  const domain = rest.includes('g.us') ? 'g.us'
    : rest.includes('lid') ? 'lid'
    : rest.includes('newsletter') ? 'newsletter'
    : rest.includes('broadcast') ? 'broadcast'
    : 's.whatsapp.net';
  return `${local}@${domain}`;
}

function getSocketJid(chatJid) {
  if (!chatJid) return chatJid;
  const formatted = formatJid(chatJid);
  if (formatted.endsWith('@s.whatsapp.net')) {
    // Check if we have a mapped LID JID for this phone JID in contactsStore
    const lidMatch = Object.keys(contactsStore).find(
      k => contactsStore[k] && contactsStore[k].phoneJid === formatted
    );
    if (lidMatch) {
      console.log(`[WA] Mapping phone JID ${formatted} back to socket LID JID ${lidMatch} for Baileys`);
      return lidMatch;
    }
  }
  return formatted;
}

function clearContactsStore() {
  for (const key of Object.keys(contactsStore)) delete contactsStore[key];
}

function pushLiveMessage(jid, message) {
  if (!jid || !message) return;
  const key = formatJid(jid);
  const list = liveMessagesStore.get(key) || [];
  const existing = list.find(m => m.id === message.id);
  if (existing) {
    if (message.status && waStatusRank(message.status) > waStatusRank(existing.status)) {
      existing.status = waStatusLabel(message.status);
    }
  } else {
    list.push(message);
  }
  list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  if (list.length > 400) list.splice(0, list.length - 400);
  liveMessagesStore.set(key, list);
}

// WhatsApp read-receipt ranks for our UI/DB labels: sent(1) < delivered(2) < read(3) < played(4)
const WA_STATUS_RANK = { sent: 1, delivered: 2, read: 3, played: 4, pending: 0, error: 0 };

// Baileys proto.WebMessageInfo.Status — DO NOT use 1..4 blindly; enum starts at PENDING=1, SERVER_ACK=2, etc.
// PENDING=1, SERVER_ACK=2 (one tick), DELIVERY_ACK=3 (two grey), READ=4 (two blue), PLAYED=5 (two blue)
const BAILEYS_STATUS_TO_LABEL = {
  [WAMessageStatus.ERROR]: 'error',
  [WAMessageStatus.PENDING]: 'pending',
  [WAMessageStatus.SERVER_ACK]: 'sent',
  [WAMessageStatus.DELIVERY_ACK]: 'delivered',
  [WAMessageStatus.READ]: 'read',
  [WAMessageStatus.PLAYED]: 'played',
};

const WA_STATUS_DEBUG = process.env.WA_STATUS_DEBUG === '1' || process.env.WA_STATUS_DEBUG === 'true';

function waStatusLabel(value) {
  if (typeof value === 'number') return BAILEYS_STATUS_TO_LABEL[value] || 'sent';
  return WA_STATUS_RANK[value] ? value : 'sent';
}

function waStatusRank(value) {
  const label = typeof value === 'number' ? waStatusLabel(value) : value;
  return WA_STATUS_RANK[label] || 0;
}

function logStatusTrace(stage, payload) {
  const line = `[WA-TICK-TRACE] ${stage} ${JSON.stringify(payload)}`;
  console.log(line);
  if (WA_STATUS_DEBUG) {
    emit('wa:status_trace', { stage, ts: Date.now(), ...payload });
  }
}

async function resolveStatusChatJid(rawJid) {
  let chatJid = formatJid(rawJid);
  if (!chatJid.endsWith('@lid')) return chatJid;
  const mapped = contactsStore[chatJid];
  if (mapped?.phoneJid) return formatJid(mapped.phoneJid);
  try {
    const accPhone = phoneNumber;
    if (!accPhone) return chatJid;
    const r = await pool.query(
      `SELECT phone FROM wa_contacts WHERE jid=$1 AND account_phone=$2 AND phone IS NOT NULL LIMIT 1`,
      [chatJid, accPhone]
    );
    if (r.rows[0]?.phone) return formatJid(`${r.rows[0].phone}@s.whatsapp.net`);
  } catch (_) { }
  return chatJid;
}

async function resolveChatJidAliases(rawJid) {
  const accPhone = phoneNumber;
  const candidates = new Set();
  const primary = formatJid(rawJid);
  const resolved = await resolveStatusChatJid(rawJid);
  candidates.add(primary);
  candidates.add(resolved);
  if (!accPhone) return [...candidates].filter(Boolean);
  const phoneDigits = (resolved || primary).endsWith('@s.whatsapp.net')
    ? (resolved || primary).split('@')[0]
    : null;
  if (phoneDigits) {
    try {
      const lids = await pool.query(
        `SELECT jid FROM wa_contacts
         WHERE account_phone=$1
           AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2
           AND jid LIKE '%@lid'`,
        [accPhone, phoneDigits]
      );
      lids.rows.forEach((r) => candidates.add(formatJid(r.jid)));
      const lidChats = await pool.query(
        `SELECT id FROM wa_chats
         WHERE account_phone=$1
           AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2
           AND id LIKE '%@lid'`,
        [accPhone, phoneDigits]
      );
      lidChats.rows.forEach((r) => candidates.add(formatJid(r.id)));
    } catch (_) { }
  }
  return [...candidates].filter(Boolean);
}

async function markIncomingMessagesReadInDb(chatJid, accPhone) {
  const aliases = await resolveChatJidAliases(chatJid);
  for (const jid of aliases) {
    const phoneDigits = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
    await pool.query(`
      UPDATE wa_messages SET is_read=true
      WHERE account_phone=$1 AND from_me=false AND is_read=false
        AND (
          chat_id=$2
          OR chat_id LIKE split_part($2, '@', 1) || ':%@' || split_part($2, '@', 2)
          OR ($3::text IS NOT NULL AND chat_id IN (
            SELECT wc.jid FROM wa_contacts wc
            WHERE wc.account_phone = $1
              AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') = $3
              AND wc.jid LIKE '%@lid'
          ))
        )
    `, [accPhone, jid, phoneDigits]).catch(() => {});
    await pool.query(
      `UPDATE wa_chats SET unread=0, updated_at=NOW() WHERE id=$1 AND account_phone=$2`,
      [jid, accPhone]
    ).catch(() => {});
    const lc = liveChatsStore.get(jid);
    if (lc) { lc.unread = 0; liveChatsStore.set(jid, lc); }
  }
  emit('wa:chat_unread_update', { jid: formatJid(chatJid), unread: 0 });
}

async function reconcileChatUnreadFromMessages(chatJid, accPhone) {
  const aliases = await resolveChatJidAliases(chatJid);
  for (const jid of aliases) {
    const phoneDigits = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
    const res = await pool.query(`
      SELECT COUNT(*)::int AS n FROM wa_messages
      WHERE account_phone=$1 AND from_me=false AND is_read=false
        AND (
          chat_id=$2
          OR chat_id LIKE split_part($2, '@', 1) || ':%@' || split_part($2, '@', 2)
          OR ($3::text IS NOT NULL AND chat_id IN (
            SELECT wc.jid FROM wa_contacts wc
            WHERE wc.account_phone = $1
              AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') = $3
              AND wc.jid LIKE '%@lid'
          ))
        )
    `, [accPhone, jid, phoneDigits]);
    const n = res.rows[0]?.n || 0;
    await pool.query(
      `UPDATE wa_chats SET unread=$1, updated_at=NOW() WHERE id=$2 AND account_phone=$3`,
      [n, jid, accPhone]
    ).catch(() => {});
    const lc = liveChatsStore.get(jid);
    if (lc) { lc.unread = n; liveChatsStore.set(jid, lc); }
    if (n > 0) emit('wa:chat_unread_update', { jid, unread: n });
  }
}

async function applyMessageStatusUpdate(key, rawStatus, source) {
  if (!key?.fromMe || !key?.id) return false;
  const statusLabel = waStatusLabel(rawStatus);
  const statusRank = waStatusRank(rawStatus);
  const protoNum = typeof rawStatus === 'number' ? rawStatus : null;

  logStatusTrace('incoming', {
    source: source || 'unknown',
    msgId: key.id,
    rawStatus,
    protoNum,
    mappedLabel: statusLabel,
    mappedRank: statusRank,
    remoteJid: key.remoteJid,
    participant: key.participant || null,
  });

  // Only upgrade outbound message ticks; ignore pending/error
  if (statusRank < 1) {
    logStatusTrace('skipped_low_rank', { msgId: key.id, statusLabel, statusRank });
    return false;
  }

  const accPhone = phoneNumber;
  if (!accPhone) return false;

  const candidates = new Set([formatJid(key.remoteJid), await resolveStatusChatJid(key.remoteJid)]);
  let updated = false;
  let matchedChatJid = null;
  let previousStatus = null;

  for (const chatJid of candidates) {
    if (!chatJid) continue;
    // Unresolved LID: allow delivered but not read/played (can't match DB row reliably for read)
    if (chatJid.endsWith('@lid') && (statusLabel === 'read' || statusLabel === 'played')) {
      logStatusTrace('skipped_lid_read', { msgId: key.id, chatJid, statusLabel });
      continue;
    }

    const phoneDigits = chatJid.endsWith('@s.whatsapp.net') ? chatJid.split('@')[0] : null;

    const before = await pool.query(
      `SELECT status FROM wa_messages WHERE id=$1 AND account_phone=$2 AND from_me=true
         AND (chat_id=$3 OR chat_id LIKE split_part($3, '@', 1) || ':%@' || split_part($3, '@', 2))
       LIMIT 1`,
      [key.id, accPhone, chatJid]
    );
    if (before.rows[0]) previousStatus = before.rows[0].status;

    const result = await pool.query(`
      UPDATE wa_messages SET status = $1
      WHERE id = $2 AND account_phone = $3 AND from_me = true
        AND (
          chat_id = $4
          OR chat_id LIKE split_part($4, '@', 1) || ':%@' || split_part($4, '@', 2)
          OR ($5::text IS NOT NULL AND chat_id IN (
            SELECT wc.jid FROM wa_contacts wc
            WHERE wc.account_phone = $3
              AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') = $5
              AND wc.jid LIKE '%@lid'
          ))
          OR ($5::text IS NOT NULL AND chat_id IN (
            SELECT wc.id FROM wa_chats wc
            WHERE wc.account_phone = $3
              AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') = $5
              AND wc.id LIKE '%@lid'
          ))
        )
        AND CASE status WHEN 'played' THEN 4 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END < $6
      RETURNING id, chat_id, status`,
      [statusLabel, key.id, accPhone, chatJid, phoneDigits, statusRank]
    );

    if (result.rowCount > 0) {
      updated = true;
      matchedChatJid = chatJid;
      for (const row of result.rows) {
        const list = liveMessagesStore.get(formatJid(row.chat_id));
        if (!list) continue;
        const msg = list.find(m => m.id === row.id);
        if (msg) msg.status = statusLabel;
      }
      break;
    }
  }

  if (updated) {
    logStatusTrace('applied', {
      msgId: key.id,
      source: source || 'unknown',
      previousStatus,
      newStatus: statusLabel,
      protoNum,
      chatJid: matchedChatJid,
    });
    emit('wa:status', { id: key.id, status: statusLabel, chatId: matchedChatJid, source: source || 'unknown', proto: protoNum });
  } else {
    logStatusTrace('no_db_row', {
      msgId: key.id,
      source: source || 'unknown',
      statusLabel,
      protoNum,
      candidates: [...candidates],
      previousStatus,
    });
  }
  return updated;
}

let updateLiveChatDebounceTimer = null;
function updateLiveChatRow(chat) {
  if (!chat?.id) return;
  const key = formatJid(chat.id);
  const existing = liveChatsStore.get(key) || {};
  const merged = {
    ...existing,
    ...chat,
    id: key,
    unread: Number(chat.unread ?? existing.unread ?? 0),
  };
  liveChatsStore.set(key, merged);

  if (!updateLiveChatDebounceTimer) {
    updateLiveChatDebounceTimer = setTimeout(() => {
      emit('wa:chats_updated', {});
      updateLiveChatDebounceTimer = null;
    }, 2000); // 2-second debounce to avoid spamming the frontend
  }
}

function readPhoneFromAuthCreds() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'));
    return resolveConnectedAccountPhone(raw?.me?.id || '');
  } catch (_) {
    return '';
  }
}

/** Real phone digits for account_phone — never a 15+ digit LID. */
function resolveConnectedAccountPhone(rawUserId) {
  const digits = normalizeAccountPhone(rawUserId);
  return isAllowedWaNumber(digits) ? digits : '';
}

function applyConnectedAccountPhone(rawUserId) {
  let acc = resolveConnectedAccountPhone(rawUserId);
  if (!acc) acc = readPhoneFromAuthCreds();
  if (!acc) return false;
  return setActiveAccountPhone(acc);
}

function setActiveAccountPhone(value) {
  const nextPhone = resolveConnectedAccountPhone(value) || normalizeAccountPhone(value);
  if (!nextPhone) return false;
  if (phoneNumber && phoneNumber !== nextPhone) {
    clearContactsStore();
    liveChatsStore.clear();
    liveMessagesStore.clear();
    importedLastTsMap = {};
    groupMetadataCache.clear();
    rawGroupMetadataCache.clear();
    lastGroupParticipantSyncAt = 0;
  }
  phoneNumber = nextPhone;
  return true;
}

function setIO(socketIO) { io = socketIO; }

function emit(event, data) {
  if (io) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (phoneNumber && !data.accountPhone) {
        data.accountPhone = phoneNumber;
      }
    }
    io.emit(event, data);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function recordActivity(stage, detail, meta = null) {
  const entry = {
    ts: new Date().toISOString(),
    stage: String(stage || 'info'),
    detail: String(detail || ''),
    meta: meta && typeof meta === 'object' ? meta : undefined,
  };
  activityBuffer.push(entry);
  lastActivityAt = Date.now();
  if (activityBuffer.length > ACTIVITY_BUFFER_LIMIT) {
    activityBuffer.splice(0, activityBuffer.length - ACTIVITY_BUFFER_LIMIT);
  }
  emit('wa:syncing', entry);
}

function startWatchdog() {
  if (!WA_WATCHDOG_ENABLED) return;
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    try {
      if (startInProgress) return;
      const now = Date.now();
      const staleForMs = now - lastActivityAt;
      const hasSession = hasSavedSession();

      if (!sock && hasSession && !isConnected && !reconnectTimer) {
        recordActivity('watchdog', 'Socket missing with saved session; restarting');
        await startWA();
        return;
      }

      if (!isConnected && hasSession && staleForMs > WA_STALE_RESTART_MS && !reconnectTimer) {
        recordActivity('watchdog', 'Disconnected state stale; scheduling reconnect', { staleForMs });
        scheduleReconnect('watchdog stale disconnected');
      }
    } catch (err) {
      console.warn('[WA] Watchdog error:', err.message);
      recordActivity('error', 'Watchdog check failed', { error: err.message });
    }
  }, WA_WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

async function isBlockedChat(jid, accPhone) {
  if (!jid || !accPhone) return false;
  try {
    const result = await pool.query(
      `SELECT 1 FROM wa_chat_blocklist WHERE account_phone=$1 AND chat_id=$2 LIMIT 1`,
      [accPhone, jid]
    );
    return result.rowCount > 0;
  } catch (_) {
    return false;
  }
}

// Helper: Normalize JID to prevent double domains and device suffixes
function formatJid(jid) {
  return normalizeRawJid(jid);
}

// Helper: Schedule reconnect with exponential backoff
function scheduleReconnect(reason) {
  if (reconnectTimer) {
    console.log('[WA] Reconnect already scheduled; keeping existing timer.');
    return;
  }
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    // On tower server with pm2, permanently stopping means WA stays dead until manual restart.
    // Instead: reset counter and retry after a longer cooldown (5 min) — self-healing.
    const cooldown = 5 * 60 * 1000;
    console.log(`[WA] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Cooling down ${cooldown / 1000}s then retrying...`);
    recordActivity('reconnect', 'Max attempts — cooldown retry', { attempts: reconnectAttempts, cooldownMs: cooldown });
    emit('wa:reconnect_failed', { attempts: reconnectAttempts });
    reconnectAttempts = 0;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (hasSavedSession()) {
        console.log('[WA] Cooldown complete — attempting to reconnect');
        startWA().catch(err => {
          console.error('[WA] Cooldown reconnect failed:', err.message);
          scheduleReconnect('cooldown reconnect failed');
        });
      }
    }, cooldown);
    return;
  }

  const delayIndex = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
  const delay = RECONNECT_DELAYS[delayIndex];
  reconnectAttempts++;
  currentState = 'RECONNECTING';

  console.log(`[WA] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms (reason: ${reason})`);
  recordActivity('reconnect', 'Reconnect scheduled', { attempt: reconnectAttempts, delay, reason });
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
// Priority: profile/saved name > pushName > formatted phone number (never raw LID digits)
function isInvalidContactLabel(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^you$/i.test(text)) return true;
  if (/^(unknown|unknown whatsapp contact)$/i.test(text)) return true;
  // WhatsApp rate-limit / protocol error strings must never be stored as names
  if (/rate.?overlimit|not-authorized|forbidden|bad.?request|not.?found|timeout|internal.?server/i.test(text)) return true;
  return false;
}

function isPhoneLikeLabel(value, phoneDigits) {
  const text = String(value || '').trim();
  if (!text || text.includes('@lid')) return false;
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return false;
  if (phoneDigits && digits === phoneDigits) return true;
  if (/^\+?\d[\d\s\-().]+$/.test(text) && digits.length >= 7) return true;
  return false;
}

function getContactName(jid, pushName) {
  if (!jid) return '';
  jid = normalizeRawJid(jid);
  const local = jid.split('@')[0].split(':')[0];
  const stored = contactsStore[jid]
    || contactsStore[local + '@s.whatsapp.net']
    || contactsStore[local + '@lid'];
  const mappedPhone = isLidJid(jid)
    ? resolvedPhoneForLid(jid, stored?.phone)
    : normalizeWaPhone(local);
  if (stored?.notify && !isInvalidContactLabel(stored.notify) && !isPhoneLikeLabel(stored.notify, mappedPhone)) {
    return stored.notify;
  }
  if (stored?.name && !isInvalidContactLabel(stored.name) && !isPhoneLikeLabel(stored.name, mappedPhone)
    && !isAllowedWaNumber(normalizeWaPhone(stored.name))) {
    return stored.name;
  }
  if (pushName && !isInvalidContactLabel(pushName) && !isPhoneLikeLabel(pushName, mappedPhone)) return pushName;
  if (mappedPhone) return formatDisplayPhone(mappedPhone);
  if (isLidJid(jid)) return '';
  return formatDisplayPhone(local);
}

const GROUP_METADATA_CONCURRENCY = 2;
const GROUP_METADATA_DELAY_MS = 600;
const LID_CONTACT_BATCH_SIZE = 200;
const LID_RESOLUTION_BATCH_SIZE = 100;
const LID_RESOLUTION_BATCH_DELAY_MS = 2500;
const MAX_GROUPS_PER_LID_BATCH = 16;
let lidResolutionWorkerTimer = null;
let lidResolutionInFlight = false;
let lidResolutionGroupCursor = 0;
let lidResolutionGroupIds = [];
let lidResolutionExhausted = false;
let lidResolutionCooldownUntil = 0;
let lidResolutionLastPassResolved = 0;

// ── HISTORY SYNC QUEUE ─────────────────────────────────────────────────────────────────
const historySyncQueue = [];
let isProcessingHistoryQueue = false;
let totalHistoryChunksReceived = 0;
let historyChunksProcessed = 0;

function isLidResolutionExhausted() {
  return lidResolutionExhausted;
}

function getLidResolutionCooldownMins() {
  if (lidResolutionCooldownUntil > Date.now()) {
    return Math.ceil((lidResolutionCooldownUntil - Date.now()) / 60000);
  }
  return 0;
}

function resetLidResolution() {
  lidResolutionCooldownUntil = 0;
  lidResolutionExhausted = false;
  lidResolutionGroupCursor = 0;
  lidResolutionGroupIds = [];
}

async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function upsertGroupMemberContacts(rows, accPhone) {
  const batch = (Array.isArray(rows) ? rows : []).filter(r => r?.jid);
  if (!batch.length || !accPhone) return 0;

  let saved = 0;
  for (let i = 0; i < batch.length; i += LID_CONTACT_BATCH_SIZE) {
    const chunk = batch.slice(i, i + LID_CONTACT_BATCH_SIZE);
    const values = [];
    const params = [accPhone];
    let idx = 2;
    for (const row of chunk) {
      values.push(`($${idx}, $1, $${idx + 1}, $${idx + 2}, true)`);
      params.push(row.jid, row.name || null, row.phone || null);
      idx += 3;
    }
    await pool.query(`
      INSERT INTO wa_contacts (jid, account_phone, name, phone, is_group_member)
      VALUES ${values.join(',')}
      ON CONFLICT (jid, account_phone) DO UPDATE SET
        phone = COALESCE(EXCLUDED.phone, wa_contacts.phone),
        name = CASE
          WHEN EXCLUDED.name IS NOT NULL AND EXCLUDED.name != '' THEN EXCLUDED.name
          ELSE wa_contacts.name
        END,
        is_group_member = true,
        updated_at = NOW()
    `, params);
    for (const row of chunk) {
      if (!contactsStore[row.jid]) contactsStore[row.jid] = { id: row.jid };
      if (row.phone) {
        contactsStore[row.jid].phone = row.phone;
        contactsStore[row.jid].phoneJid = `${row.phone}@s.whatsapp.net`;
      }
      if (row.name && !isInvalidContactLabel(row.name)) contactsStore[row.jid].name = row.name;
    }
    saved += chunk.length;
  }
  return saved;
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
    'secretEncryptedMessage'
  ];
  return !skip.includes(type);
}

// Helper: Resolve LID JID to Phone JID using contactsStore or database
async function resolveJidToPhone(rawJid) {
  let jid = formatJid(rawJid);
  if (jid.endsWith('@lid')) {
    const mapped = contactsStore[jid];
    if (mapped?.phoneJid) {
      return mapped.phoneJid;
    }
    const accPhone = phoneNumber;
    if (accPhone) {
      try {
        const lidLookup = await pool.query(
          `SELECT phone FROM wa_contacts
           WHERE jid=$1 AND account_phone=$2
             AND phone IS NOT NULL AND phone != ''
           LIMIT 1`,
          [jid, accPhone]
        );
        const resolvedPhone = resolvedPhoneForLid(jid, lidLookup.rows?.[0]?.phone);
        if (resolvedPhone) {
          const resolvedPhoneJid = `${resolvedPhone}@s.whatsapp.net`;
          if (!contactsStore[jid]) contactsStore[jid] = { id: jid };
          contactsStore[jid].phoneJid = resolvedPhoneJid;
          return resolvedPhoneJid;
        }
      } catch (_) { }
    }
  }
  return jid;
}

// ── HANDLE PROTOCOL MESSAGE EDIT ────────────────────────────────────────────────
async function handleProtocolMessageEdit(msg) {
  const protocolMsg = msg.message?.protocolMessage;
  const secretEncMsg = msg.message?.secretEncryptedMessage;
  
  // Can be a protocolMessage (upsert/update) or editedMessage directly on message (update)
  let editedMsg = null;
  let targetKey = null;

  if (msg.message?.editedMessage) {
    editedMsg = msg.message.editedMessage.message || msg.message.editedMessage;
    targetKey = msg.key;
  } else if (protocolMsg?.type === 14 || protocolMsg?.editedMessage) {
    editedMsg = protocolMsg.editedMessage;
    targetKey = protocolMsg.key;
  } else if (secretEncMsg && (secretEncMsg.secretEncType === 'MESSAGE_EDIT' || secretEncMsg.secretEncType === 2)) {
    targetKey = secretEncMsg.targetMessageKey;
    if (targetKey && targetKey.id) {
      try {
        const accPhone = phoneNumber;
        if (accPhone) {
          // 1. Get the original message's secret from DB
          const checkRes = await pool.query(
            `SELECT message_secret FROM wa_messages WHERE id=$1 AND account_phone=$2 LIMIT 1`,
            [targetKey.id, accPhone]
          );
          if (checkRes.rows[0]?.message_secret) {
            const secretBuf = Buffer.from(checkRes.rows[0].message_secret, 'base64');
            // 2. Determine the sender JID
            const fromMe = targetKey.fromMe || false;
            const isLidChat = targetKey.remoteJid?.endsWith('@lid');
            let senderJid = null;
            if (fromMe) {
              senderJid = isLidChat ? (userLid || userJid) : userJid;
            } else {
              senderJid = targetKey.participant || msg.key?.participant || targetKey.remoteJid;
            }
            if (senderJid) {
              const sender = normalizeRawJid(senderJid);
              
              // 3. Normalize payload and IV
              let payloadBuf = secretEncMsg.encPayload;
              if (typeof payloadBuf === 'string') {
                payloadBuf = Buffer.from(payloadBuf, 'base64');
              } else if (payloadBuf && payloadBuf.type === 'Buffer' && Array.isArray(payloadBuf.data)) {
                payloadBuf = Buffer.from(payloadBuf.data);
              } else {
                payloadBuf = Buffer.from(payloadBuf);
              }

              let ivBuf = secretEncMsg.encIv;
              if (typeof ivBuf === 'string') {
                ivBuf = Buffer.from(ivBuf, 'base64');
              } else if (ivBuf && ivBuf.type === 'Buffer' && Array.isArray(ivBuf.data)) {
                ivBuf = Buffer.from(ivBuf.data);
              } else {
                ivBuf = Buffer.from(ivBuf);
              }

              const { aesDecryptGCM, hmacSign, proto } = require('@whiskeysockets/baileys');
              
              const toBinary = (txt) => Buffer.from(txt);
              const senderBuf = toBinary(sender);
              
              const sign = Buffer.concat([
                toBinary(targetKey.id),
                senderBuf,
                senderBuf,
                toBinary('Message Edit'),
                new Uint8Array([1])
              ]);

              const key = hmacSign(secretBuf, new Uint8Array(32));
              const decKey = hmacSign(sign, key);
              
              const decryptedBytes = aesDecryptGCM(payloadBuf, decKey, ivBuf, '');
              const decryptedMsg = proto.Message.decode(decryptedBytes);
              
              editedMsg = decryptedMsg;
              console.log(`[WA] Successfully decrypted secretEncryptedMessage for target ${targetKey.id}`);
            } else {
              console.warn(`[WA] Could not determine sender JID for secretEncryptedMessage decryption`);
            }
          } else {
            console.warn(`[WA] Original message ${targetKey.id} secret not found in database`);
          }
        }
      } catch (err) {
        console.error(`[WA] Failed to decrypt secretEncryptedMessage:`, err.message);
      }
    }
  }

  if (!editedMsg || !targetKey || !targetKey.id) return false;

  const newText = getBody({ message: editedMsg });
  if (newText !== undefined && newText !== null) {
    const targetChatJid = formatJid(targetKey.remoteJid || msg.key?.remoteJid);
    const accPhone = phoneNumber;
    if (accPhone) {
      // Retrieve actual stored chat JID if the message is in DB
      const msgRow = await pool.query(
        `SELECT chat_id FROM wa_messages WHERE id=$1 AND account_phone=$2 LIMIT 1`,
        [targetKey.id, accPhone]
      );
      
      const resolvedJid = msgRow.rows[0]
        ? msgRow.rows[0].chat_id
        : await resolveJidToPhone(targetChatJid);

      console.log(`[WA] Intercepted edit for message ${targetKey.id} in chat ${resolvedJid} (original JID: ${targetChatJid}): ${newText.substring(0, 30)}`);
      
      await pool.query(
        `UPDATE wa_messages SET body=$1 WHERE id=$2 AND chat_id=$3 AND account_phone=$4`,
        [newText, targetKey.id, resolvedJid, accPhone]
      );
      try {
        const latestRow = await pool.query(
          `SELECT id FROM wa_messages WHERE chat_id=$1 AND account_phone=$2 ORDER BY timestamp DESC LIMIT 1`,
          [resolvedJid, accPhone]
        );
        if (latestRow.rows[0] && latestRow.rows[0].id === targetKey.id) {
          await pool.query(
            `UPDATE wa_chats SET last_message=$1 WHERE id=$2 AND account_phone=$3`,
            [newText, resolvedJid, accPhone]
          );
          emit('wa:chats_updated', {});
        }
      } catch (_) {}
      emit('wa:message_edited', {
        id: targetKey.id,
        chatId: resolvedJid,
        body: newText
      });
      return true;
    }
  }
  return false;
}

// ── HANDLE PROTOCOL MESSAGE REVOKE (delete for everyone) ────────────────────────
async function handleProtocolMessageRevoke(msg) {
  const protocolMsg = msg.message?.protocolMessage;
  const isRevoke = (protocolMsg && (protocolMsg.type === 0 || protocolMsg.type === 'REVOKE'))
    || msg.messageStubType === 0
    || msg.messageStubType === 'REVOKE';

  if (!isRevoke) return false;

  const targetKey = protocolMsg ? protocolMsg.key : msg.key;
  if (targetKey && targetKey.id) {
    const targetChatJid = formatJid(targetKey.remoteJid || msg.key?.remoteJid);
    const accPhone = phoneNumber;
    if (accPhone) {
      // Retrieve actual stored chat JID if the message is in DB
      const msgRow = await pool.query(
        `SELECT chat_id FROM wa_messages WHERE id=$1 AND account_phone=$2 LIMIT 1`,
        [targetKey.id, accPhone]
      );
      
      const resolvedJid = msgRow.rows[0]
        ? msgRow.rows[0].chat_id
        : await resolveJidToPhone(targetChatJid);

      console.log(`[WA] Intercepted revoke/delete for message ${targetKey.id} in chat ${resolvedJid}`);
      
      // Remove the message from the local DB
      await pool.query(
        `DELETE FROM wa_messages WHERE id=$1 AND chat_id=$2 AND account_phone=$3`,
        [targetKey.id, resolvedJid, accPhone]
      );
      
      // If it was the last message, update the chat's last message
      try {
        const latestRow = await pool.query(
          `SELECT body FROM wa_messages WHERE chat_id=$1 AND account_phone=$2 ORDER BY timestamp DESC LIMIT 1`,
          [resolvedJid, accPhone]
        );
        const newLastMsg = latestRow.rows[0] ? latestRow.rows[0].body : '';
        await pool.query(
          `UPDATE wa_chats SET last_message=$1 WHERE id=$2 AND account_phone=$3`,
          [newLastMsg, resolvedJid, accPhone]
        );
        emit('wa:chats_updated', {});
      } catch (_) {}
      
      emit('wa:message_deleted', {
        id: targetKey.id,
        chatId: resolvedJid
      });
      return true;
    }
  }
  return false;
}

// ── SYNC CHAT DELETIONS (polling + diff workaround) ───────────────────────────
async function syncChatDeletions(chatJid) {
  if (!sock || !isConnected || !phoneNumber) return;
  // sock.fetchMessagesFromWA does not exist in Baileys — skip silently
  if (typeof sock.fetchMessagesFromWA !== 'function') return;
  const accPhone = phoneNumber;
  const formattedJid = formatJid(chatJid);
  const socketJid = getSocketJid(formattedJid);

  console.log(`[WA] Syncing deletions for chat: ${formattedJid} (socket JID: ${socketJid})`);

  try {
    // 1. Fetch latest 100 messages from WhatsApp servers
    const currentMsgs = await sock.fetchMessagesFromWA(socketJid, 100);
    if (!Array.isArray(currentMsgs)) return;

    const currentIds = new Set(currentMsgs.map(m => m.key?.id).filter(Boolean));

    // 2. Get messages we have in CRM for this chat
    // Find oldest timestamp in the fetched messages to avoid falsely deleting older messages
    let oldestTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // default to 30 days
    if (currentMsgs.length > 0) {
      const timestamps = currentMsgs
        .map(m => m.messageTimestamp ? toDate(m.messageTimestamp).getTime() : null)
        .filter(Boolean);
      if (timestamps.length > 0) {
        oldestTimestamp = new Date(Math.min(...timestamps) - 10000); // 10s buffer
      }
    }

    const crmMsgs = await pool.query(
      `SELECT id FROM wa_messages 
       WHERE chat_id=$1 AND account_phone=$2 AND timestamp >= $3`,
      [formattedJid, accPhone, oldestTimestamp]
    );

    const crmRows = crmMsgs.rows;
    if (crmRows.length === 0) return;

    // 3. Diff: delete in CRM if exists in CRM but NOT in current WA messages list
    let deletedCount = 0;
    for (const row of crmRows) {
      if (!currentIds.has(row.id)) {
        console.log(`[WA-DIFF] Message ${row.id} in chat ${formattedJid} was deleted on phone. Deleting from CRM.`);
        await pool.query(
          `DELETE FROM wa_messages WHERE id=$1 AND chat_id=$2 AND account_phone=$3`,
          [row.id, formattedJid, accPhone]
        );
        emit('wa:message_deleted', {
          id: row.id,
          chatId: formattedJid
        });
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      // Update last message of chat
      try {
        const latestRow = await pool.query(
          `SELECT body FROM wa_messages WHERE chat_id=$1 AND account_phone=$2 ORDER BY timestamp DESC LIMIT 1`,
          [formattedJid, accPhone]
        );
        const newLastMsg = latestRow.rows[0] ? latestRow.rows[0].body : '';
        await pool.query(
          `UPDATE wa_chats SET last_message=$1 WHERE id=$2 AND account_phone=$3`,
          [newLastMsg, formattedJid, accPhone]
        );
        emit('wa:chats_updated', {});
      } catch (_) {}
    }
  } catch (err) {
    console.warn(`[WA] syncChatDeletions failed for ${formattedJid}:`, err.message);
  }
}

let deletionSyncTimer = null;

function startDeletionSyncWorker() {
  if (deletionSyncTimer) return;
  deletionSyncTimer = setInterval(async () => {
    if (!sock || !isConnected || !phoneNumber) return;
    try {
      // Get the top 5 most recently active chats in the last 7 days to poll
      const activeChats = await pool.query(
        `SELECT id FROM wa_chats 
         WHERE account_phone=$1 AND last_time >= NOW() - INTERVAL '7 days'
         ORDER BY last_time DESC LIMIT 5`,
        [phoneNumber]
      );
      
      for (const row of activeChats.rows) {
        await syncChatDeletions(row.id);
        // Delay between chats to avoid rate limit spikes
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (e) {
      console.error('[WA] Deletion sync worker error:', e.message);
    }
  }, 2 * 60 * 1000); // Run every 2 minutes
  console.log('[WA] Deletion sync worker started.');
}

function stopDeletionSyncWorker() {
  if (deletionSyncTimer) {
    clearInterval(deletionSyncTimer);
    deletionSyncTimer = null;
    console.log('[WA] Deletion sync worker stopped.');
  }
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

// Helper: Extract message secret from the message context metadata
function getMessageSecret(msg) {
  try {
    if (!msg || !msg.message) return null;
    if (msg.message.messageContextInfo?.messageSecret) {
      return msg.message.messageContextInfo.messageSecret;
    }
    const types = Object.keys(msg.message);
    for (const type of types) {
      const subMsg = msg.message[type];
      if (subMsg && typeof subMsg === 'object' && subMsg.contextInfo?.messageSecret) {
        return subMsg.contextInfo.messageSecret;
      }
    }
  } catch (_) {}
  return null;
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
          is_group_member BOOLEAN DEFAULT FALSE,
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
          message_secret TEXT,
          PRIMARY KEY (id, chat_id, account_phone)
        )
      `);
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS quoted_body TEXT`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS is_reply BOOLEAN DEFAULT FALSE`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS reply_to_msg_id VARCHAR(200)`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_path TEXT`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS message_secret TEXT`).catch(() => { });
      await pool.query(`ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS imported_last_ts TIMESTAMPTZ`).catch(() => { });
      await pool.query(`ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS is_announce BOOLEAN DEFAULT FALSE`).catch(() => { });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wa_chat_blocklist (
          account_phone VARCHAR(50) NOT NULL,
          chat_id VARCHAR(100) NOT NULL,
          reason TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (account_phone, chat_id)
        )
      `);

      // Handle migrations for multi-account support on existing databases (e.g. Tower Server)
      await pool.query(`ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS account_phone VARCHAR(50) DEFAULT 'unknown'`).catch(() => { });
      await pool.query(`ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS is_group_member BOOLEAN DEFAULT FALSE`).catch(() => { });
      await pool.query(`ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS verified_name TEXT`).catch(() => { });
      await pool.query(`ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS is_business BOOLEAN DEFAULT FALSE`).catch(() => { });
      await pool.query(`UPDATE wa_contacts SET is_business = true WHERE verified_name IS NOT NULL AND is_business = false`).catch(() => { });
      // Clean up: LID contacts with no resolved phone should not carry stale names (wrong data from old syncs)
      await pool.query(`UPDATE wa_contacts SET name = NULL, notify = NULL WHERE jid LIKE '%@lid' AND (phone IS NULL OR phone = '')`).catch(() => { });
      // Fix wa_messages: if a sender_name appears for 3+ distinct @lid senders in same group, it's a bleed — clear it
      await pool.query(`
        UPDATE wa_messages SET sender_name = NULL
        WHERE sender LIKE '%@lid'
          AND sender_name IS NOT NULL
          AND sender_name IN (
            SELECT sender_name FROM wa_messages
            WHERE sender LIKE '%@lid' AND sender_name IS NOT NULL
            GROUP BY chat_id, sender_name
            HAVING COUNT(DISTINCT sender) >= 3
          )
      `).catch(() => { });
      await pool.query(`ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS account_phone VARCHAR(50) DEFAULT 'unknown'`).catch(() => { });
      await pool.query(`ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS profile_pic_url TEXT`).catch(() => { });
      await pool.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS account_phone VARCHAR(50) DEFAULT 'unknown'`).catch(() => { });

      try {
        await pool.query(`ALTER TABLE wa_contacts DROP CONSTRAINT IF EXISTS wa_contacts_pkey CASCADE`);
        await pool.query(`ALTER TABLE wa_contacts ADD PRIMARY KEY (jid, account_phone)`);
      } catch (e) { }

      try {
        await pool.query(`ALTER TABLE wa_chats DROP CONSTRAINT IF EXISTS wa_chats_pkey CASCADE`);
        await pool.query(`ALTER TABLE wa_chats ADD PRIMARY KEY (id, account_phone)`);
      } catch (e) { }

      try {
        await pool.query(`ALTER TABLE wa_messages DROP CONSTRAINT IF EXISTS wa_messages_pkey CASCADE`);
        await pool.query(`ALTER TABLE wa_messages ADD PRIMARY KEY (id, chat_id, account_phone)`);
      } catch (e) { }

      // ── PERFORMANCE INDEXES ────────────────────────────────────────────────
      // These are the critical indexes that make chat loading fast on both
      // dev laptop and tower server. All use IF NOT EXISTS — safe to re-run.

      // wa_messages: primary query index (chat_id + account_phone + timestamp DESC)
      // Powers: /messages/:jid ORDER BY timestamp DESC LIMIT N
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_messages_chat_ts
        ON wa_messages (account_phone, chat_id, timestamp DESC NULLS LAST)
      `).catch(() => {});

      // wa_messages: covering index for the read-status update query
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_messages_unread
        ON wa_messages (account_phone, chat_id, from_me, is_read)
        WHERE is_read = false AND from_me = false
      `).catch(() => {});

      // wa_chats: account_phone lookup (used in every /chats query and LATERAL join)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_chats_account_updated
        ON wa_chats (account_phone, last_time DESC NULLS LAST)
      `).catch(() => {});

      // wa_chats: blocklist join
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_chat_blocklist_lookup
        ON wa_chat_blocklist (account_phone, chat_id)
      `).catch(() => {});

      // wa_contacts: jid lookup for sender name resolution in messages query
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_contacts_account
        ON wa_contacts (account_phone, jid)
      `).catch(() => {});

      // wa_contacts: phone lookup used in enriched_contacts CTE and lid_biz LATERAL
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_contacts_phone
        ON wa_contacts (account_phone, phone)
        WHERE phone IS NOT NULL
      `).catch(() => {});

      // wa_messages: sender lookup for enriched_contacts LATERAL (sender_name resolution)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_messages_sender_name
        ON wa_messages (account_phone, sender, timestamp DESC NULLS LAST)
        WHERE from_me = false AND sender_name IS NOT NULL AND sender_name != ''
      `).catch(() => {});

      // wa_chats: id lookup for contact_rows NOT EXISTS subquery
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_chats_id
        ON wa_chats (account_phone, id)
      `).catch(() => {});

      // wa_contacts: is_group_member filter used in contact_rows
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_wa_contacts_group_member
        ON wa_contacts (account_phone, is_group_member)
        WHERE is_group_member = false
      `).catch(() => {});

      // Labels
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wa_labels (
          id           VARCHAR(50),
          account_phone VARCHAR(50),
          name         VARCHAR(100),
          color        INT DEFAULT 0,
          created_at   TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (id, account_phone)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wa_label_associations (
          label_id     VARCHAR(50),
          account_phone VARCHAR(50),
          chat_id      VARCHAR(100),
          PRIMARY KEY (label_id, account_phone, chat_id)
        )
      `);

      // One-time group name cleanup
      await pool.query(`
        UPDATE wa_chats
        SET name = NULL
        WHERE is_group = true
          AND name IS NOT NULL
          AND (
            name = id
            OR name = split_part(id,'@',1)
            OR (name ~ '^[0-9]{12,}' AND name NOT LIKE '%@%')
          )
      `).catch(() => {});

      return; // Success
    } catch (err) {
      console.warn(`[WA] Table ensure attempt ${i + 1} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// ── SAVE CHAT ────────────────────────────────────────────────────────────────────────
// unreadMode:
//   'increment' — add `unread` to existing count (new incoming message)
//   'set'       — replace with absolute value from WhatsApp sync (default when unread=0)
async function saveChat(rawJid, name, lastMsg, lastTime, unread, isGroup, opts = {}) {
  if (isNonChatJid(rawJid)) return;
  let jid = normalizeRawJid(rawJid);

  const phone = jid.split('@')[0].split(':')[0];
  const isGroupChat = !!isGroup || jid.endsWith('@g.us');
  let displayPhone = isGroupChat ? null : formatDisplayPhone(phone);
  if (!isGroupChat && isLidJid(jid)) {
    let mappedPhone = resolvedPhoneForLid(jid, contactsStore[jid]?.phone);
    if (!mappedPhone && contactsStore[jid]?.phoneJid) {
      mappedPhone = normalizeWaPhone(contactsStore[jid].phoneJid);
    }
    if (!mappedPhone && phoneNumber) {
      try {
        const lidLookup = await pool.query(
          `SELECT phone FROM wa_contacts
           WHERE jid=$1 AND account_phone=$2
             AND phone IS NOT NULL AND phone != ''
           LIMIT 1`,
          [jid, phoneNumber]
        );
        mappedPhone = resolvedPhoneForLid(jid, lidLookup.rows?.[0]?.phone);
      } catch (_) { }
    }
    if (mappedPhone) {
      jid = `${mappedPhone}@s.whatsapp.net`;
      displayPhone = formatDisplayPhone(mappedPhone);
    } else {
      displayPhone = null;
    }
  }
  const cleanName = String(name || '').trim();
  const groupIdLocal = jid.split('@')[0].split(':')[0];
  const safeName = isGroupChat && (
    cleanName === groupIdLocal ||
    cleanName === ('+' + groupIdLocal) ||
    cleanName === jid ||                          // full JID stored as name
    /^\d{12,}/.test(cleanName.replace(/@[a-z.]+$/i, '')) // 12+ digit prefix (group IDs)
  )
    ? null
    : (cleanName && !isInvalidContactLabel(cleanName) ? cleanName : null);
  const ts = lastTime instanceof Date ? lastTime : toDate(lastTime);
  const unreadVal = Number(unread) || 0;
  const unreadMode = opts.unreadMode || (unreadVal === 0 ? 'set' : 'increment');
  updateLiveChatRow({
    id: jid,
    name: safeName || displayPhone,
    phone: displayPhone,
    is_group: isGroupChat,
    last_message: lastMsg || '',
    last_time: ts || null,
    unread: unreadMode === 'set' ? unreadVal : (liveChatsStore.get(formatJid(jid))?.unread || 0) + unreadVal,
  });
  if (!WA_DYNAMIC_DB_STORE) return;
  try {
    const accPhone = phoneNumber;
    if (!accPhone) return;
    if (await isBlockedChat(jid, accPhone)) return;
    const unreadSql = unreadMode === 'set'
      ? 'EXCLUDED.unread'
      : `CASE WHEN EXCLUDED.unread = 0 THEN 0 ELSE wa_chats.unread + EXCLUDED.unread END`;
    await pool.query(`
      INSERT INTO wa_chats (id, account_phone, name, phone, is_group, last_message, last_time, unread)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id, account_phone) DO UPDATE SET
        name         = COALESCE(EXCLUDED.name, wa_chats.name),
        phone        = COALESCE(EXCLUDED.phone, wa_chats.phone),
        is_group     = wa_chats.is_group OR EXCLUDED.is_group,
        last_message = CASE WHEN EXCLUDED.last_message != '' THEN EXCLUDED.last_message ELSE wa_chats.last_message END,
        last_time    = GREATEST(COALESCE(EXCLUDED.last_time, wa_chats.last_time), COALESCE(wa_chats.last_time, EXCLUDED.last_time)),
        unread       = ${unreadSql},
        updated_at   = NOW()
    `, [jid, accPhone, safeName || displayPhone, displayPhone, isGroupChat, lastMsg || '', ts, unreadVal]);
  } catch (err) {
    console.error(`[WA-DB] saveChat error ${jid}:`, err.message);
  }
}

// ── SAVE / UPDATE CONTACT ──────────────────────────────────────────────────────────────
async function saveContact(contact) {
  const rawId = contact?.lid || contact?.id;
  if (!rawId) return;
  const accPhone = phoneNumber;
  if (!accPhone) return;
  const jid = normalizeRawJid(rawId);
  let phone = isLidJid(jid) ? '' : normalizeWaPhone(jid.split('@')[0].split(':')[0]);
  let name = contact.name || null;
  let notify = contact.notify || contact.username || null;
  const verifiedName = contact.verifiedName || null;
  const isBusiness = !!(contact.isBusiness || contact.verifiedName);
  if (name && (isInvalidContactLabel(name) || isPhoneLikeLabel(name, phone) || normalizeWaPhone(name) === phone)) {
    name = null;
  }
  if (notify && (isInvalidContactLabel(notify) || isPhoneLikeLabel(notify, phone))) {
    notify = null;
  }

  // Update in-memory store
  contactsStore[jid] = { id: jid, name, notify, phone };

  if (!name && verifiedName && !isInvalidContactLabel(verifiedName) && !isPhoneLikeLabel(verifiedName, phone)) {
    name = verifiedName;
  }

  // Identity Mapping: If this is an LID, extract the real phone number
  if (isLidJid(jid)) {
    if (contact.id && contact.id.endsWith('@s.whatsapp.net')) {
      const realPhone = resolvedPhoneForLid(jid, contact.id);
      if (realPhone) {
        phone = realPhone;
        contactsStore[jid].phone = realPhone;
        contactsStore[jid].phoneJid = `${realPhone}@s.whatsapp.net`;
      }
    } else if (contact.phoneNumber) {
      const pNum = typeof contact.phoneNumber === 'string' ? contact.phoneNumber : contact.phoneNumber.jid;
      const realPhone = resolvedPhoneForLid(jid, pNum);
      if (realPhone) {
        phone = realPhone;
        contactsStore[jid].phone = realPhone;
        contactsStore[jid].phoneJid = `${realPhone}@s.whatsapp.net`;
      }
    } else {
      phone = '';
    }
  }

  if (!WA_DYNAMIC_DB_STORE) return;
  try {
    await pool.query(`
      INSERT INTO wa_contacts (jid, account_phone, name, notify, phone, verified_name, is_business)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (jid, account_phone) DO UPDATE SET
        name          = COALESCE(EXCLUDED.name,          wa_contacts.name),
        notify        = COALESCE(EXCLUDED.notify,        wa_contacts.notify),
        verified_name = COALESCE(EXCLUDED.verified_name, wa_contacts.verified_name),
        is_business   = EXCLUDED.is_business OR wa_contacts.is_business,
        phone  = CASE
          WHEN EXCLUDED.phone IS NOT NULL AND EXCLUDED.phone != '' THEN EXCLUDED.phone
          ELSE wa_contacts.phone
        END,
        updated_at = NOW()
    `, [jid, accPhone, name, notify, phone || null, verifiedName || null, isBusiness]);
  } catch (_) { }
}

// ── SAVE MESSAGE ──────────────────────────────────────────────────────────────────────
async function saveMessage(msg) {
  try {
    if (!isRealMessage(msg)) return null;

    const rawJid = msg.key.remoteJid;
    // Normalize JID: remove device suffixes and resolve LID to phone if possible
    let jid = rawJid.split(':')[0].split('@')[0] + '@' + rawJid.split('@')[1];

    // LID to Phone resolution (from in-memory map first, DB fallback)
    if (jid.endsWith('@lid')) {
      const mapped = contactsStore[jid];
      if (mapped?.phoneJid) {
        jid = mapped.phoneJid;
      } else if (phoneNumber) {
        try {
          const lidLookup = await pool.query(
            `SELECT phone FROM wa_contacts
             WHERE jid=$1 AND account_phone=$2
               AND phone IS NOT NULL AND phone != ''
             LIMIT 1`,
            [jid, phoneNumber]
          );
          const resolvedPhone = resolvedPhoneForLid(jid, lidLookup.rows?.[0]?.phone);
          if (resolvedPhone) {
            const resolvedPhoneJid = `${resolvedPhone}@s.whatsapp.net`;
            if (!contactsStore[jid]) contactsStore[jid] = { id: jid };
            contactsStore[jid].phoneJid = resolvedPhoneJid;
            jid = resolvedPhoneJid;
          }
        } catch (_) { }
      }
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
    const accPhone = phoneNumber;
    if (!accPhone) return null;
    if (await isBlockedChat(jid, accPhone)) return null;
    const msgStatus = fromMe ? waStatusLabel(msg.status) : null;
    const liveRow = {
      id,
      chat_id: jid,
      account_phone: accPhone,
      from_me: fromMe,
      sender: senderJid,
      sender_name: senderName,
      body,
      msg_type: type,
      timestamp: ts ? ts.toISOString() : new Date().toISOString(),
      is_read: fromMe,
      status: msgStatus || null,
      quoted_body: quotedBody,
      is_reply: replyInfo.isReply,
      reply_to_msg_id: replyInfo.replyToMsgId,
      media_path: mediaPath,
      sender_phone: senderJid && !String(senderJid).endsWith('@g.us')
        ? (() => {
          // LID JIDs are internal WA identifiers, not phone numbers — resolve from contactsStore
          if (String(senderJid).endsWith('@lid')) {
            const resolvedPhone = contactsStore[senderJid]?.phone;
            if (!resolvedPhone) return null;
            const digits = String(resolvedPhone).replace(/\D/g, '');
            if (!digits) return null;
            if (digits.startsWith('91') && digits.length === 12) return '+91 ' + digits.slice(2, 7) + ' ' + digits.slice(7);
            return '+' + digits;
          }
          const digits = String(senderJid).split('@')[0].split(':')[0].replace(/\D/g, '');
          if (!digits) return null;
          if (digits.startsWith('91') && digits.length === 12) return '+91 ' + digits.slice(2, 7) + ' ' + digits.slice(7);
          return '+' + digits;
        })()
        : null,
    };
    const secret = getMessageSecret(msg);
    const messageSecretBase64 = secret ? Buffer.from(secret).toString('base64') : null;

    pushLiveMessage(jid, liveRow);
    if (!WA_DYNAMIC_DB_STORE) {
      return { id, jid, fromMe, sender: senderJid, senderName, body, type, ts, quotedBody, isReply: replyInfo.isReply, replyToMsgId: replyInfo.replyToMsgId, mediaPath, status: msgStatus || 'sent' };
    }
    // Resolve status from Baileys: 1=sent, 2=delivered, 3=read, 4=played

    await pool.query(`
      INSERT INTO wa_messages (id, chat_id, account_phone, from_me, sender, sender_name, body, msg_type, timestamp, is_read, status, quoted_body, is_reply, reply_to_msg_id, media_path, message_secret)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (id, chat_id, account_phone) DO UPDATE SET
        status = CASE
          WHEN CASE wa_messages.status WHEN 'played' THEN 4 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END
             < CASE EXCLUDED.status WHEN 'played' THEN 4 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END
          THEN EXCLUDED.status
          ELSE wa_messages.status
        END,
        message_secret = COALESCE(wa_messages.message_secret, EXCLUDED.message_secret)
    `, [id, jid, accPhone, fromMe, senderJid, senderName, body, type, ts, fromMe, msgStatus || 'sent', quotedBody, replyInfo.isReply, replyInfo.replyToMsgId, mediaPath, messageSecretBase64]);

    // Persist pushName as notify so chat list reflects the sender's current WA profile name
    if (!fromMe && !jid.endsWith('@g.us') && msg.pushName && !isInvalidContactLabel(msg.pushName) && !isPhoneLikeLabel(msg.pushName, '')) {
      const contactJid = senderJid || jid;
      contactsStore[contactJid] = { ...(contactsStore[contactJid] || {}), notify: msg.pushName };
      pool.query(`
        INSERT INTO wa_contacts (jid, account_phone, notify)
        VALUES ($1, $2, $3)
        ON CONFLICT (jid, account_phone) DO UPDATE SET
          notify = EXCLUDED.notify,
          updated_at = NOW()
        WHERE (wa_contacts.name IS NULL OR wa_contacts.name = '')
      `, [contactJid, accPhone, msg.pushName]).catch(() => {});
    }

    return { id, jid, fromMe, sender: senderJid, senderName, body, type, ts, quotedBody, isReply: replyInfo.isReply, replyToMsgId: replyInfo.replyToMsgId, mediaPath, status: msgStatus || 'sent' };
  } catch (err) {
    console.error('[WA-DB] saveMessage error:', err.message);
    return null;
  }
}

// ── LOAD CONTACTS FROM DB INTO MEMORY ──────────────────────────────────────────────────
async function loadContactsFromDB() {
  try {
    const accPhone = phoneNumber;
    clearContactsStore();
    if (!accPhone) {
      console.log('[WA] Skipping contact preload until connected account is known');
      return;
    }
    // Include phone so LID entries get their phoneJid pre-populated for group msg rendering
    const res = await pool.query(`SELECT jid, name, notify, phone, is_group_member FROM wa_contacts WHERE account_phone=$1`, [accPhone]);
    res.rows.forEach(r => {
      const entry = { id: r.jid, name: r.name, notify: r.notify, is_group_member: !!r.is_group_member };
      // Pre-populate phoneJid for @lid contacts so saveMessage can resolve senders immediately
      if (isLidJid(r.jid)) {
        const mapped = resolvedPhoneForLid(r.jid, r.phone);
        if (mapped) {
          entry.phone = mapped;
          entry.phoneJid = `${mapped}@s.whatsapp.net`;
        }
      }
      contactsStore[r.jid] = entry;
      // Also index by phone number for cross-format lookup
      const phone = r.jid.split('@')[0].split(':')[0];
      if (phone && !contactsStore[phone]) {
        contactsStore[phone] = { id: r.jid, name: r.name, notify: r.notify, is_group_member: !!r.is_group_member };
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
    const accPhone = phoneNumber;
    if (!accPhone) return;
    const res = await pool.query(
      `SELECT jid, phone FROM wa_contacts WHERE account_phone=$1 AND jid LIKE '%@lid' AND phone IS NOT NULL AND phone != ''`,
      [accPhone]
    );
    let mapped = 0;
    for (const r of res.rows) {
      const mappedPhone = resolvedPhoneForLid(r.jid, r.phone);
      if (!mappedPhone) continue;
      if (!contactsStore[r.jid]) contactsStore[r.jid] = { id: r.jid };
      contactsStore[r.jid].phone = mappedPhone;
      contactsStore[r.jid].phoneJid = `${mappedPhone}@s.whatsapp.net`;
      mapped++;
    }
    console.log(`[WA] LID→phone map refreshed: ${mapped} entries`);
  } catch (err) {
    console.error('[WA] loadLidPhoneMapFromDB error:', err.message);
  }
}

// ── VALIDATE & CLEAN LID MAPPINGS ON CONNECT ─────────────────────────────────────────
// Wipes invalid phone values stored against LID JIDs so they re-enter the pending queue
// and get properly resolved by the LID resolution worker.
// Invalid = phone is blank, non-numeric, same as the LID number itself, or wrong length.
async function validateAndCleanLidMappings() {
  try {
    const accPhone = phoneNumber;
    if (!accPhone) return;
    const result = await pool.query(`
      UPDATE wa_contacts
      SET phone = NULL, updated_at = NOW()
      WHERE account_phone = $1
        AND jid LIKE '%@lid'
        AND phone IS NOT NULL
        AND (
          regexp_replace(phone, '[^0-9]', '', 'g') = split_part(jid, '@', 1)
          OR NOT (regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$')
        )
      RETURNING jid
    `, [accPhone]);
    const cleaned = result.rowCount || 0;
    if (cleaned > 0) {
      console.log(`[WA] LID validation: cleared ${cleaned} invalid phone mapping(s) — will re-resolve`);
      // Remove bad entries from in-memory store too
      for (const row of result.rows) {
        if (contactsStore[row.jid]) {
          delete contactsStore[row.jid].phone;
          delete contactsStore[row.jid].phoneJid;
        }
      }
    } else {
      console.log(`[WA] LID validation: all stored LID→phone mappings look valid`);
    }
  } catch (err) {
    console.error('[WA] validateAndCleanLidMappings error:', err.message);
  }
}

// ── START WHATSAPP ────────────────────────────────────────────────────────────────────
async function startWA(options = {}) {
  await loadBaileys();
  startWatchdog();
  const allowQR = !!options.allowQR;
  if (allowQR) allowQrGeneration = true;
  recordActivity('startup', 'Starting WhatsApp service', { allowQR });

  if (startInProgress) {
    console.log('[WA] startWA ignored: start already in progress');
    recordActivity('startup', 'Startup already in progress');
    return;
  }
  if (sock && isConnected) {
    console.log('[WA] startWA ignored: already connected');
    recordActivity('startup', 'Already connected');
    return;
  }

  startInProgress = true;
  const generation = ++socketGeneration;
  await ensureTables();

  if (!allowQrGeneration && !hasSavedSession()) {
    console.log('[WA] No saved session. WhatsApp will stay idle until QR is requested from WhatsApp Biz.');
    currentState = 'DISCONNECTED';
    recordActivity('idle', 'Waiting for QR request (no saved session)');
    startInProgress = false;
    return;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Scope DB writes to the real linked phone (creds.me.id), not the LID user id.
  const hasCreds = !!state.creds?.me?.id;
  if (hasCreds) {
    applyConnectedAccountPhone(state.creds.me.id);
    userJid = state.creds.me.id;
    userLid = state.creds.me.lid || null;
    // Only load existing data when we have a known account — skip for fresh QR scan
    await loadContactsFromDB();
    await loadImportedCheckpointsFromDB();
    await updateChatNames();
  }

  let version = [2, 3000, 1017539718]; // Recent fallback version
  try {
    // Cap at 5s — on tower server this can hang and delay QR generation
    const res = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    version = res.version;
  } catch (err) {
    console.warn('[WA] Version fetch timeout/error, using fallback v' + version.join('.'));
  }

  console.log('[WA] Starting Baileys v' + version.join('.'));
  recordActivity('startup', 'WhatsApp engine booting', { version: version.join('.') });

  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) { }
    try { sock.end?.(); } catch (_) { }
  }

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['UniComm', 'Chrome', '124.0.0'],
    syncFullHistory: SYNC_FULL_HISTORY,
    // Baileys 7: when omitted, this defaults to () => !!syncFullHistory.
    // With syncFullHistory=false that SKIPS all history + app-state chat loading on QR connect.
    shouldSyncHistoryMessage: () => true,
    logger: require('pino')({ level: 'info' }), // Enabled info level to see Baileys internal logs
    getMessage: async (key) => {
      if (!phoneNumber) return { conversation: '' };
      console.log('[WA-DEBUG] getMessage called with key:', JSON.stringify(key));
      try {
        const res = await pool.query(
          `SELECT body, message_secret, msg_type FROM wa_messages WHERE id=$1 AND account_phone=$2`,
          [key.id, phoneNumber]
        );
        if (!res.rows[0]) {
          console.log('[WA-DEBUG] getMessage: no message found in database for ID:', key.id);
          return { conversation: '' };
        }
        const row = res.rows[0];
        console.log('[WA-DEBUG] getMessage: found message in database:', JSON.stringify({ id: key.id, body: row.body, msg_type: row.msg_type, has_secret: !!row.message_secret }));
        const message = { conversation: row.body || '' };
        if (row.message_secret) {
          const secretBuf = Buffer.from(row.message_secret, 'base64');
          message.messageContextInfo = {
            messageSecret: secretBuf
          };
          const msgType = row.msg_type || 'conversation';
          if (msgType === 'extendedTextMessage') {
            message.extendedTextMessage = { text: row.body || '', contextInfo: { messageSecret: secretBuf } };
          } else if (msgType === 'imageMessage') {
            message.imageMessage = { caption: row.body || '', contextInfo: { messageSecret: secretBuf } };
          } else if (msgType === 'videoMessage') {
            message.videoMessage = { caption: row.body || '', contextInfo: { messageSecret: secretBuf } };
          } else if (msgType === 'documentMessage') {
            message.documentMessage = { contextInfo: { messageSecret: secretBuf } };
          } else if (msgType !== 'conversation') {
            message.extendedTextMessage = { text: row.body || '', contextInfo: { messageSecret: secretBuf } };
          }
        }
        console.log('[WA-DEBUG] getMessage returning constructed message structure keys:', Object.keys(message));
        return message;
      } catch (e) {
        console.error('[WA] Error in getMessage:', e.message);
        return { conversation: '' };
      }
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
      recordActivity('qr', 'QR ready, waiting for scan');
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
      pairingCode = null;
      pairingPhone = null;
      const rawId = sock.user?.id || '';

      // Detect number switch: if a different account just connected (e.g. new QR scan),
      // flush in-memory state so old account's contacts/chats don't bleed through.
      const incomingPhone = normalizeAccountPhone(rawId);
      if (phoneNumber && incomingPhone && incomingPhone !== phoneNumber) {
        console.log(`[WA] Account switched from ${phoneNumber} → ${incomingPhone}, clearing in-memory store`);
        clearContactsStore();
        liveChatsStore.clear();
        liveMessagesStore.clear();
        importedLastTsMap = {};
        groupMetadataCache.clear();
        rawGroupMetadataCache.clear();
        isReconnect = false; // treat as fresh connect
      }

      // sock.user.id may be phone JID or @lid — always scope DB to creds.me.id phone.
      applyConnectedAccountPhone(rawId);
      userJid = rawId;
      userLid = sock.user?.lid || state.creds?.me?.lid || null;
      console.log(`[WA] Connected as ${phoneNumber} | raw id: ${rawId} | reconnect: ${isReconnect}`);
      recordActivity('connected', 'WhatsApp connected', { phone: phoneNumber, reconnect: isReconnect });
      await loadContactsFromDB();
      await loadImportedCheckpointsFromDB();
      await updateChatNames();
      await consolidateLidChats();
      emit('wa:connected', { phone: phoneNumber, name: sock.user?.name });
      startDeletionSyncWorker();

      // Immediately refresh LID→phone map so group msg senders resolve on reconnect
      await loadLidPhoneMapFromDB();
      // Validate stored LID→phone mappings — wipe invalid ones so they re-resolve cleanly
      await validateAndCleanLidMappings();

      // After connect: scan ALL groups and populate LID→phone in wa_contacts
      // Delay 60s to let WhatsApp settle before making group metadata requests
      setTimeout(() => {
        if (generation !== socketGeneration || !isConnected) return;
        startLidResolutionWorker();
      }, 4000);

      // After connect: fetch subjects for any groups with null name in DB
      setTimeout(async () => {
        if (generation !== socketGeneration || !isConnected || !phoneNumber) return;
        try { await refreshCurrentAccountGroupMetadata(200); } catch(e) {}
      }, 12000);

      // If DB is empty after connect, wait for history sync to arrive then resync.
      // Retries up to 6 times (max ~90s) to handle slow WhatsApp history delivery.
      (async () => {
        const delays = [8000, 15000, 20000, 20000, 15000, 12000];
        for (const delay of delays) {
          await new Promise(r => setTimeout(r, delay));
          if (generation !== socketGeneration || !isConnected || !phoneNumber) return;
          try {
            const dbCount = await countAccountChats(phoneNumber);
            if (dbCount > 0) return; // already populated (history sync did it)
            const socketCount = getSocketChatsSnapshot().length;
            if (socketCount > 0) {
              console.log(`[WA] DB empty but socket has ${socketCount} chats — resyncing directory`);
              await resyncDirectoryFromSocket({ groupLimit: 80 });
              return;
            }
            console.log(`[WA] DB empty and socket has 0 chats — waiting for history sync...`);
          } catch (err) {
            console.warn('[WA] Post-connect directory resync skipped:', err.message);
            return;
          }
        }
      })();
    }

    if (connection === 'close') {
      stopLidResolutionWorker();
      stopDeletionSyncWorker();
      isConnected = false;
      currentState = 'DISCONNECTED';
      const code = (lastDisconnect?.error)?.output?.statusCode || (lastDisconnect?.error)?.code;
      const reason = lastDisconnect?.error?.message || 'unknown';
      emit('wa:disconnected', { code: code || null, reason });
      recordActivity('disconnected', 'Connection closed');
      console.warn(`[WA] Connection closed. Code: ${code}, Reason: ${reason}`);
      recordActivity('disconnected', 'Disconnect reason captured', { code: code || null, reason });
      if (lastDisconnect?.error) {
        console.error('[WA] Full Disconnect Error:', JSON.stringify(lastDisconnect.error, null, 2));
      }

      if (code === DisconnectReason.loggedOut) {
        // User logged out - clear session and restart
        console.log('[WA] Logged out - clearing session');
        phoneNumber = null;
        userJid = null;
        userLid = null;
        clearContactsStore();
        importedLastTsMap = {};
        groupMetadataCache.clear();
        rawGroupMetadataCache.clear();
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
        phoneNumber = null;
        userJid = null;
        userLid = null;
        clearContactsStore();
        importedLastTsMap = {};
        groupMetadataCache.clear();
        rawGroupMetadataCache.clear();
        clearSession();
        reconnectAttempts = 0;
        if (allowQrGeneration) scheduleReconnect('unauthorized');
      } else if (code === 500 || code === 503 || !code || hasSavedSession()) {
        // Server, network, or unclassified close: retry with exponential backoff.
        scheduleReconnect(`disconnect ${code || 'unknown'}`);
      } else {
        // Unknown code — still reconnect if we have a session; don't silently die.
        console.log('[WA] Unknown disconnect code:', code, '— reconnecting anyway');
        if (hasSavedSession()) scheduleReconnect(`disconnect unknown code ${code}`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── GENERIC EVENT TASK QUEUE ───────────────────────────────────────────────────────────
  // Prevents heavy array iterations from stalling the Baileys event loop
  const bgTaskQueue = [];
  let isProcessingBgTasks = false;
  async function processBgTasks() {
    if (isProcessingBgTasks) return;
    isProcessingBgTasks = true;
    while (bgTaskQueue.length > 0) {
      const task = bgTaskQueue.shift();
      try { await task(); } catch (err) { console.error('[WA] BG Task Error:', err.message); }
      await new Promise(r => setTimeout(r, 10)); // Yield to event loop
    }
    isProcessingBgTasks = false;
  }
  function enqueueBgTask(task) {
    bgTaskQueue.push(task);
    processBgTasks().catch(console.error);
  }

  // ── CONTACTS SYNC ──────────────────────────────────────────────────────────────────────
  sock.ev.on('contacts.upsert', (contacts) => {
    enqueueBgTask(async () => {
      console.log(`[WA] contacts.upsert count=${contacts.length}`);
      for (const c of contacts) {
        await saveContact(c);
      }
      await updateChatNames();
    });
  });

  sock.ev.on('contacts.update', (updates) => {
    enqueueBgTask(async () => {
      for (const c of updates) {
        await saveContact(c);
      }
      await enrichContactNamesFromMessages();
    });
  });

  sock.ev.on('lid-mapping.update', async ({ lid, pn }) => {
    if (!lid || !pn || !phoneNumber) return;
    const lidJid = String(lid).includes('@') ? normalizeRawJid(lid) : `${lid}@lid`;
    const phoneJid = String(pn).includes('@') ? pn : `${normalizeWaPhone(pn)}@s.whatsapp.net`;
    await saveContact({ id: lidJid, phoneNumber: phoneJid });
    await enrichContactNamesFromMessages();
    await consolidateLidChats();
  });

  async function processHistoryQueue() {
    if (isProcessingHistoryQueue) return;
    isProcessingHistoryQueue = true;
    
    while (historySyncQueue.length > 0) {
      const { chats, contacts, messages, isLatest } = historySyncQueue.shift();
      historyChunksProcessed++;
      const yieldEventLoop = () => new Promise(resolve => setTimeout(resolve, 10));

      if (!SYNC_FULL_HISTORY) {
        console.log(`[WA] Directory sync chunk ${historyChunksProcessed}/${totalHistoryChunksReceived} — chats=${chats.length} contacts=${contacts?.length || 0} messages=${messages.length} isLatest=${isLatest}`);
        recordActivity('sync', `Directory sync chunk ${historyChunksProcessed}/${totalHistoryChunksReceived}`, { chats: chats.length, contacts: contacts?.length || 0, messages: messages.length, isLatest: !!isLatest });
        
        if (contacts?.length) {
          for (let i = 0; i < contacts.length; i++) {
            await saveContact(contacts[i]);
            if (i % 50 === 0) await yieldEventLoop();
          }
        }
        for (let i = 0; i < chats.length; i++) {
          const chat = chats[i];
          if (!chat?.id || isNonChatJid(chat.id)) continue;
          const isGroup = chat.id.endsWith('@g.us');
          const name = isGroup
            ? (chat.subject || chat.name || null)
            : getContactName(chat.id, chat.name || chat.notify);
          const ts = toDate(chat.conversationTimestamp);
          await saveChat(chat.id, name, '', ts, 0, isGroup);
          if (i % 50 === 0) await yieldEventLoop();
        }
        let saved = 0;
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.key && msg.key.id && msg.message) {
            msgCache.set(msg.key.id, msg);
            if (msgCache.size > MAX_CACHE) msgCache.delete(msgCache.keys().next().value);
          }
          const isEdit = await handleProtocolMessageEdit(msg).catch(e => console.error('[WA-History] Edit parse error:', e.message));
          if (isEdit) continue;
          if (!isRealMessage(msg)) continue;
          const jid = msg.key?.remoteJid;
          if (!jid || isNonChatJid(jid)) continue;
          const result = await saveMessage(msg);
          if (result) {
            saved++;
            historySyncState.totalMessagesLoaded++;
            historySyncState.chatMessageCounts[jid] = (historySyncState.chatMessageCounts[jid] || 0) + 1;
            const isGroup = jid.endsWith('@g.us');
            const name = isGroup ? null : getContactName(jid, msg.key.fromMe ? null : msg.pushName);
            await saveChat(jid, name, result.body, result.ts, 0, isGroup);
          }
          if (i % 50 === 0) await yieldEventLoop();
        }
        
        if (saved > 0) {
          console.log(`[WA] Directory chunk saved — ${saved} messages`);
          let maxJid = null; let maxCount = 0;
          let currentChunkCounts = {};
          for (let i = 0; i < messages.length; i++) {
             const jid = messages[i]?.key?.remoteJid;
             if (jid && isRealMessage(messages[i])) {
                currentChunkCounts[jid] = (currentChunkCounts[jid] || 0) + 1;
             }
          }
          for (const [jid, count] of Object.entries(currentChunkCounts)) {
             if (count > maxCount) { maxCount = count; maxJid = jid; }
          }
          emit('wa:history_sync_progress', {
            totalChatsDiscovered: Object.keys(historySyncState.chatMessageCounts).length,
            totalMessagesLoaded: historySyncState.totalMessagesLoaded,
            latestActiveChat: maxJid ? getContactName(maxJid) : null,
            latestActiveChatMessagesLoaded: maxJid ? historySyncState.chatMessageCounts[maxJid] : 0,
            chunksProcessed: historyChunksProcessed,
            chunksTotal: totalHistoryChunksReceived
          });
        }
        if (isLatest && historySyncQueue.length === 0) {
          enqueueBgTask(async () => await updateChatNames());
          await consolidateLidChats();
          await loadLidPhoneMapFromDB();
          recordActivity('sync', 'Directory sync complete');
          emit('wa:sync_complete', {});
        }
        continue;
      }
      
      console.log(`[WA] History chunk ${historyChunksProcessed}/${totalHistoryChunksReceived} — chats=${chats.length} contacts=${contacts?.length || 0} messages=${messages.length} isLatest=${isLatest}`);
      recordActivity('sync', `History sync chunk ${historyChunksProcessed}/${totalHistoryChunksReceived}`, { chats: chats.length, contacts: contacts?.length || 0, messages: messages.length, isLatest: !!isLatest });

      // 1. Save contacts FIRST (needed for name resolution)
      if (contacts?.length) {
        for (let i = 0; i < contacts.length; i++) {
          await saveContact(contacts[i]);
          if (i % 50 === 0) await yieldEventLoop();
        }
      }

      // 2. Save chats with resolved names
      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const isGroup = chat.id.endsWith('@g.us');
        const name = isGroup
          ? (chat.name || null)
          : getContactName(chat.id, chat.name);
        const ts = toDate(chat.conversationTimestamp);
        await saveChat(chat.id, name, '', ts, 0, isGroup);
        if (i % 50 === 0) await yieldEventLoop();
      }

      // 3. Save real messages + cache for media download
      let saved = 0;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.key && msg.key.id && msg.message) {
          msgCache.set(msg.key.id, msg);
          if (msgCache.size > MAX_CACHE) msgCache.delete(msgCache.keys().next().value);
        }
        if (!isRealMessage(msg)) continue;
        const jid = msg.key?.remoteJid;
        if (!jid || isNonChatJid(jid)) continue;
        const result = await saveMessage(msg);
        if (result) {
          saved++;
          historySyncState.totalMessagesLoaded++;
          historySyncState.chatMessageCounts[jid] = (historySyncState.chatMessageCounts[jid] || 0) + 1;
          const isGroup = jid.endsWith('@g.us');
          const name = isGroup ? null : getContactName(jid, msg.key.fromMe ? null : msg.pushName);
          await saveChat(jid, name, result.body, result.ts, 0, isGroup);
        }
        if (i % 50 === 0) await yieldEventLoop();
      }
      
      if (saved > 0) {
        console.log(`[WA] Chunk saved — ${saved} messages`);
        let maxJid = null; let maxCount = 0;
        let currentChunkCounts = {};
        for (let i = 0; i < messages.length; i++) {
           const jid = messages[i]?.key?.remoteJid;
           if (jid && isRealMessage(messages[i])) {
              currentChunkCounts[jid] = (currentChunkCounts[jid] || 0) + 1;
           }
        }
        for (const [jid, count] of Object.entries(currentChunkCounts)) {
           if (count > maxCount) { maxCount = count; maxJid = jid; }
        }
        emit('wa:history_sync_progress', {
          totalChatsDiscovered: Object.keys(historySyncState.chatMessageCounts).length,
          totalMessagesLoaded: historySyncState.totalMessagesLoaded,
          latestActiveChat: maxJid ? getContactName(maxJid) : null,
          latestActiveChatMessagesLoaded: maxJid ? historySyncState.chatMessageCounts[maxJid] : 0,
          chunksProcessed: historyChunksProcessed,
          chunksTotal: totalHistoryChunksReceived
        });
      }
      // 4. Only refresh frontend on FINAL chunk (isLatest=true)
      if (isLatest && historySyncQueue.length === 0) {
        console.log('[WA] ✅ Full history sync complete — refreshing UI');
        enqueueBgTask(async () => await updateChatNames());
        await consolidateLidChats();
        await loadLidPhoneMapFromDB();
        // try { await refreshCurrentAccountGroupMetadata(200); } catch(e){} // Removed to prevent rate limit timeout
        recordActivity('sync', 'Full history sync complete');
        emit('wa:sync_complete', {});
      }
    }
    isProcessingHistoryQueue = false;
  }

  sock.ev.on('messaging-history.set', (payload) => {
    totalHistoryChunksReceived++;
    historySyncQueue.push(payload);
    processHistoryQueue().catch(err => console.error('[WA] History sync error:', err));
  });

  // ── CHAT LIST UPDATES ──────────────────────────────────────────────────────────────────
  // Track whether we already have data so reconnect chats.upsert doesn't cause duplicate renders
  let chatsUpsertDebounce = null;
  let chatsBatchCount = 0;
  sock.ev.on('chats.upsert', (chats) => {
    console.log(`[WA] chats.upsert fired: ${chats.length} chats`);
    enqueueBgTask(async () => {
      chatsBatchCount++;
      for (const chat of chats) {
        const isGroup = chat.id.endsWith('@g.us');
        const name = isGroup
          ? (chat.subject || chat.name || null)
          : getContactName(chat.id, chat.name);
        await saveChat(chat.id, name, '', toDate(chat.conversationTimestamp), 0, isGroup);
      }
      // Debounce: wait 1.5s after the last batch before refreshing the UI.
      if (chatsUpsertDebounce) clearTimeout(chatsUpsertDebounce);
      chatsUpsertDebounce = setTimeout(async () => {
        const batches = chatsBatchCount;
        chatsBatchCount = 0;
        chatsUpsertDebounce = null;
        try {
          enqueueBgTask(async () => await updateChatNames());
          await consolidateLidChats();
          await loadLidPhoneMapFromDB();
          // Fetch missing group subjects
          try { await refreshCurrentAccountGroupMetadata(200); } catch(e){}
        } catch (err) {
          console.warn('[WA] chats.upsert post-save error:', err.message);
        }
        console.log(`[WA] chats.upsert settled (${batches} batches) — refreshing UI`);
        emit('wa:sync_complete', { source: 'chats.upsert', batches });
        emit('wa:chats_updated', {});
      }, 3000);
    });
  });

  // ── CHAT READ/UNREAD SYNC FROM MOBILE ───────────────────────────────────────────────
  // Fires when the user reads or marks-unread a chat on their phone.
  sock.ev.on('chats.update', (updates) => {
    const accPhone = phoneNumber;
    if (!accPhone) return;
    for (const update of updates) {
      if (!update?.id || isNonChatJid(update.id)) continue;
      if (update.unreadCount === undefined || update.unreadCount === null) continue;
      const rawUnread = Number(update.unreadCount);
      const newUnread = rawUnread === -1 ? 1 : Math.max(0, rawUnread || 0);
      resolveChatJidAliases(update.id).then((aliases) => {
        for (const jid of aliases) {
          pool.query(
            `UPDATE wa_chats SET unread=$1, updated_at=NOW() WHERE id=$2 AND account_phone=$3`,
            [newUnread, jid, accPhone]
          ).catch(() => {});
          const lc = liveChatsStore.get(jid);
          if (lc) { lc.unread = newUnread; liveChatsStore.set(jid, lc); }
        }
        emit('wa:chat_unread_update', { jid: formatJid(update.id), unread: newUnread });
      }).catch(() => {});
    }
  });

  // ── REAL-TIME MESSAGES ───────────────────────────────────────────────────────────────
  // ── LABEL SYNC FROM MOBILE ────────────────────────────────────────────────
  sock.ev.on('labels.edit', (label) => {
    const accPhone = phoneNumber;
    if (!accPhone || !label?.id) return;
    pool.query(`
      INSERT INTO wa_labels (id, account_phone, name, color)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (id, account_phone) DO UPDATE SET name=$3, color=$4
    `, [label.id, accPhone, label.name || '', label.color ?? 0]).catch(() => {});
    emit('wa:labels_updated', { type: 'edit', label: { id: label.id, name: label.name, color: label.color } });
  });

  sock.ev.on('labels.association', ({ association, type }) => {
    const accPhone = phoneNumber;
    if (!accPhone || !association?.labelId || !association?.chatId) return;
    const chatId = normalizeRawJid(association.chatId);
    if (type === 'add') {
      pool.query(`
        INSERT INTO wa_label_associations (label_id, account_phone, chat_id)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
      `, [association.labelId, accPhone, chatId]).catch(() => {});
    } else {
      pool.query(`
        DELETE FROM wa_label_associations WHERE label_id=$1 AND account_phone=$2 AND chat_id=$3
      `, [association.labelId, accPhone, chatId]).catch(() => {});
    }
    emit('wa:labels_updated', { type: 'association', association: { ...association, chatId }, action: type });
  });

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
            const mediaDir = MEDIA_DIR;
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
      if (msg.message) {
        console.log(`[WA-DEBUG] messages.upsert type: ${getContentType(msg.message)} | message keys: ${Object.keys(msg.message).join(', ')} | content: ${JSON.stringify(msg.message)}`);
      }
      // Check if it is a message edit protocol message
      const isEdit = await handleProtocolMessageEdit(msg).catch(err => console.error('[WA] Edit process error:', err.message));
      if (isEdit) continue;
      // Check if it is a message revoke protocol message
      const isRevoke = await handleProtocolMessageRevoke(msg).catch(err => console.error('[WA] Revoke process error:', err.message));
      if (isRevoke) continue;
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

      await saveChat(jid, chatName, saved.body, saved.ts, msg.key.fromMe ? 0 : 1, isGroup, { unreadMode: 'increment' });

      if (type === 'notify' && isRealMessage(msg) && !msg.key.fromMe) {
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
          chatId: saved.jid,
          fromMe: saved.fromMe,
          sender: saved.sender,
          senderName: saved.senderName,
          body: saved.body,
          type: saved.type,
          ts: saved.ts,
          mediaPath: saved.mediaPath,
          status: saved.status || (saved.fromMe ? 'sent' : null),

          quotedBody: saved.quotedBody,
          isReply: saved.isReply,
          replyToMsgId: saved.replyToMsgId,

          chatName,
        });
      }
    }
  });

  // ── MESSAGE STATUS (1:1 chats via messages.update) ─────────────────────────────────
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.status && key.fromMe) {
        await applyMessageStatusUpdate(key, update.status, 'messages.update');
      }

      if (update.message) {
        console.log(`[WA-DEBUG] messages.update for key ${JSON.stringify(key)} with message keys: ${Object.keys(update.message).join(', ')} | content: ${JSON.stringify(update.message)}`);
        try {
          // Check if it's a message edit protocol message
          const isEdit = await handleProtocolMessageEdit({ key, message: update.message })
            .catch(err => console.error('[WA] messages.update edit error:', err.message));
          if (isEdit) continue;

          // Check if it's a message revoke protocol message
          const isRevoke = await handleProtocolMessageRevoke({ key, message: update.message })
            .catch(err => console.error('[WA] messages.update revoke error:', err.message));
          if (isRevoke) continue;

          // If not an edit, then it's a regular decrypted message update.
          // Let's check if the message exists in the database.
          const accPhone = phoneNumber;
          if (accPhone) {
            const checkRes = await pool.query(
              `SELECT 1 FROM wa_messages WHERE id=$1 AND account_phone=$2 LIMIT 1`,
              [key.id, accPhone]
            );
            
            const targetChatJid = formatJid(key.remoteJid);
            const resolvedJid = await resolveJidToPhone(targetChatJid);

            if (checkRes.rowCount > 0) {
              const newText = getBody({ message: update.message });
              if (newText !== undefined && newText !== null) {
                console.log(`[WA] Intercepted body update in messages.update for message ${key.id} in chat ${resolvedJid}: ${newText.substring(0, 30)}`);
                await pool.query(
                  `UPDATE wa_messages SET body=$1 WHERE id=$2 AND chat_id=$3 AND account_phone=$4`,
                  [newText, key.id, resolvedJid, accPhone]
                );
                const latestRow = await pool.query(
                  `SELECT id FROM wa_messages WHERE chat_id=$1 AND account_phone=$2 ORDER BY timestamp DESC LIMIT 1`,
                  [resolvedJid, accPhone]
                );
                if (latestRow.rows[0] && latestRow.rows[0].id === key.id) {
                  await pool.query(
                    `UPDATE wa_chats SET last_message=$1 WHERE id=$2 AND account_phone=$3`,
                    [newText, resolvedJid, accPhone]
                  );
                  emit('wa:chats_updated', {});
                }
                emit('wa:message_edited', {
                  id: key.id,
                  chatId: resolvedJid,
                  body: newText
                });
              }
            } else {
              // Message does not exist, save it as a new message!
              console.log(`[WA] Late decrypted message received in messages.update for message ${key.id}`);
              const fullMsg = {
                key,
                message: update.message,
                messageTimestamp: update.messageTimestamp || Math.floor(Date.now() / 1000),
                pushName: update.pushName || null,
                status: update.status || null
              };
              const saved = await saveMessage(fullMsg);
              if (saved) {
                const isGroup = resolvedJid.endsWith('@g.us');
                const chatName = isGroup
                  ? getContactName(resolvedJid, null)
                  : getContactName(resolvedJid, key.fromMe ? null : update.pushName);
                await saveChat(resolvedJid, chatName, saved.body, saved.ts, key.fromMe ? 0 : 1, isGroup, { unreadMode: 'increment' });
                emit('wa:message', {
                  id: saved.id,
                  chatId: resolvedJid,
                  fromMe: saved.fromMe,
                  sender: saved.sender,
                  senderName: saved.senderName,
                  body: saved.body,
                  type: saved.type,
                  ts: saved.ts,
                  mediaPath: saved.mediaPath,
                  status: saved.status || (saved.fromMe ? 'sent' : null),
                  quotedBody: saved.quotedBody,
                  isReply: saved.isReply,
                  replyToMsgId: saved.replyToMsgId,
                  chatName,
                });
              }
            }
          }
        } catch (err) {
          console.error('[WA] Failed to process message edit update:', err.message);
        }
      }
    }
  });

  // ── MESSAGE STATUS (group chats via message-receipt.update in Baileys 7) ───────────
  sock.ev.on('message-receipt.update', async (updates) => {
    for (const { key, receipt } of updates) {
      if (!key?.fromMe || !key?.id || !receipt) continue;
      let statusNum = 0;
      if (receipt.readTimestamp) statusNum = WAMessageStatus.READ;
      else if (receipt.receiptTimestamp) statusNum = WAMessageStatus.DELIVERY_ACK;
      if (!statusNum) continue;
      await applyMessageStatusUpdate(key, statusNum, 'message-receipt.update');
    }
  });

  // ── GROUP METADATA ──────────────────────────────────────────────────────────────────
  sock.ev.on('groups.upsert', async (groups) => {
    for (const g of groups) {
      const accPhone = phoneNumber;
      if (!accPhone) continue;
      await pool.query(
        `UPDATE wa_chats SET name=COALESCE($1, name) WHERE id=$2 AND account_phone=$3`,
        [g.subject || null, g.id, accPhone]
      );
      contactsStore[g.id] = { id: g.id, name: g.subject };
    }
  });

  sock.ev.on('groups.update', async (updates) => {
    for (const g of updates) {
      if (g.subject) {
        const accPhone = phoneNumber;
        if (!accPhone) continue;
        await pool.query(`UPDATE wa_chats SET name=$1 WHERE id=$2 AND account_phone=$3`, [g.subject, g.id, accPhone]);
        contactsStore[g.id] = { id: g.id, name: g.subject };
      }
    }
  });

  return sock;
}

// ── BACKFILL PROFILE NAMES FROM MESSAGE HISTORY ───────────────────────────────────────
let isEnrichingContactNames = false;
let needsEnrichContactNames = false;
async function enrichContactNamesFromMessages() {
  if (isEnrichingContactNames) {
    needsEnrichContactNames = true;
    return;
  }
  isEnrichingContactNames = true;
  try {
    do {
      needsEnrichContactNames = false;
      await _inner_enrichContactNamesFromMessages();
    } while (needsEnrichContactNames);
  } catch(e) {
    console.error('[WA] enrichContactNames wrapper error:', e.message);
  }
  isEnrichingContactNames = false;
}

async function _inner_enrichContactNamesFromMessages() {
  const accPhone = phoneNumber;
  if (!accPhone) return;
  try {
    const res = await pool.query(`
      UPDATE wa_contacts wc
      SET notify = src.sender_name, updated_at = NOW()
      FROM (
        SELECT DISTINCT ON (wc2.jid)
          wc2.jid,
          m.sender_name
        FROM wa_contacts wc2
        JOIN wa_messages m ON m.account_phone = wc2.account_phone
          AND m.from_me = false
          AND m.sender_name IS NOT NULL
          AND m.sender_name != ''
          AND m.sender_name !~* '^you$'
          AND m.sender_name !~ '^\\+?[0-9]'
          AND (
            m.sender = wc2.jid
            OR regexp_replace(split_part(COALESCE(m.sender, ''), '@', 1), '[^0-9]', '', 'g')
              = regexp_replace(COALESCE(wc2.phone, ''), '[^0-9]', '', 'g')
          )
        WHERE wc2.account_phone = $1
          AND (wc2.notify IS NULL OR wc2.notify = '')
          AND (wc2.name IS NULL OR wc2.name = '' OR wc2.name ~ '^\\+?[0-9]')
        ORDER BY wc2.jid, m.timestamp DESC NULLS LAST
      ) src
      WHERE wc.jid = src.jid AND wc.account_phone = $1
      RETURNING wc.jid
    `, [accPhone]);
    if (res.rowCount > 0) {
      console.log(`[WA] Enriched ${res.rowCount} contact names from message history`);
    }

    const chats = await pool.query(`
      UPDATE wa_contacts wc
      SET notify = COALESCE(NULLIF(wc.notify, ''), src.chat_name), updated_at = NOW()
      FROM (
        SELECT
          wc2.jid,
          c.name AS chat_name
        FROM wa_contacts wc2
        JOIN wa_chats c ON c.account_phone = wc2.account_phone
          AND (
            c.id = wc2.jid
            OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')
              = regexp_replace(COALESCE(wc2.phone, ''), '[^0-9]', '', 'g')
          )
        WHERE wc2.account_phone = $1
          AND c.name IS NOT NULL
          AND c.name != ''
          AND c.name !~ '^\\+?[0-9]'
          AND NOT c.is_group
      ) src
      WHERE wc.jid = src.jid
        AND wc.account_phone = $1
        AND (wc.notify IS NULL OR wc.notify = '')
      RETURNING wc.jid
    `, [accPhone]);
    if (chats.rowCount > 0) {
      console.log(`[WA] Enriched ${chats.rowCount} contact names from chat titles`);
    }
  } catch (err) {
    console.error('[WA] enrichContactNamesFromMessages error:', err.message);
  }
}

// ── CLEAN PHONE-FORMATTED NAMES STORED AS CONTACT NAMES ─────────────────────────────
async function cleanupContactLabels() {
  const accPhone = phoneNumber;
  if (!accPhone) return;
  try {
    await pool.query(`
      UPDATE wa_contacts
      SET name = NULL, updated_at = NOW()
      WHERE account_phone = $1
        AND (
          name ~* '^you$'
          OR name ~ '^\\+?[0-9]'
          OR regexp_replace(COALESCE(name, ''), '[^0-9]', '', 'g') = split_part(jid, '@', 1)
        )
    `, [accPhone]);
    await pool.query(`
      UPDATE wa_contacts
      SET notify = NULL, updated_at = NOW()
      WHERE account_phone = $1
        AND (
          notify ~* '^you$'
          OR notify ~ '^\\+?[0-9]'
        )
    `, [accPhone]);
    await pool.query(`
      UPDATE wa_chats
      SET name = NULL, updated_at = NOW()
      WHERE account_phone = $1
        AND name ~* '^you$'
    `, [accPhone]);
    await pool.query(`
      UPDATE wa_chats
      SET name = NULL, phone = NULL, updated_at = NOW()
      WHERE account_phone = $1
        AND id LIKE '%@lid'
        AND (
          name ~ '^\\+?[0-9]'
          OR regexp_replace(COALESCE(name, ''), '[^0-9]', '', 'g') = split_part(id, '@', 1)
        )
    `, [accPhone]);
    await pool.query(`
      DELETE FROM wa_chats c
      WHERE c.account_phone = $1
        AND c.id LIKE '%@lid'
        AND COALESCE(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), '') = ''
        AND COALESCE(NULLIF(c.name, ''), (
          SELECT NULLIF(wc.notify, '')
          FROM wa_contacts wc
          WHERE wc.jid = c.id AND wc.account_phone = c.account_phone
          LIMIT 1
        )) IS NULL
    `, [accPhone]);
  } catch (err) {
    console.error('[WA] cleanupContactLabels error:', err.message);
  }
}

// ── MERGE @lid CHATS INTO PHONE JIDS ─────────────────────────────────────────────────
let isConsolidating = false;
let needsConsolidation = false;
async function consolidateLidChats() {
  if (isConsolidating) {
    needsConsolidation = true;
    return { merged: 0 };
  }
  isConsolidating = true;
  let totalMerged = 0;
  try {
    do {
      needsConsolidation = false;
      const res = await _inner_consolidateLidChats();
      if (res && res.merged) totalMerged += res.merged;
    } while (needsConsolidation);
  } catch(e) {
    console.error('[WA] consolidate wrapper error:', e.message);
  }
  isConsolidating = false;
  return { merged: totalMerged };
}

async function _inner_consolidateLidChats() {
  const accPhone = phoneNumber;
  if (!accPhone) return { merged: 0 };
  try {
    const mergedRes = await pool.query(`
      WITH lids AS (
        SELECT
          c.id,
          CASE WHEN c.name ~* '^you$' THEN NULL ELSE c.name END AS name,
          c.last_message,
          c.last_time,
          c.unread,
          NULLIF(
            CASE
              WHEN regexp_replace(COALESCE(wc.phone, c.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$'
                AND regexp_replace(COALESCE(wc.phone, c.phone, ''), '[^0-9]', '', 'g') != split_part(c.id, '@', 1)
              THEN regexp_replace(COALESCE(wc.phone, c.phone, ''), '[^0-9]', '', 'g')
              ELSE NULL
            END,
            ''
          ) AS phone_digits
        FROM wa_chats c
        LEFT JOIN wa_contacts wc ON wc.jid = c.id AND wc.account_phone = c.account_phone
        WHERE c.account_phone = $1 AND c.id LIKE '%@lid'
      ),
      resolved AS (
        SELECT
          id,
          name,
          last_message,
          last_time,
          unread,
          phone_digits,
          phone_digits || '@s.whatsapp.net' AS phone_jid
        FROM lids
        WHERE phone_digits IS NOT NULL
      ),
      moved_messages AS (
        UPDATE wa_messages m
        SET chat_id = r.phone_jid
        FROM resolved r
        WHERE m.account_phone = $1 AND m.chat_id = r.id
        RETURNING r.id
      ),
      upserted AS (
        INSERT INTO wa_chats (id, account_phone, name, phone, is_group, last_message, last_time, unread)
        SELECT
          r.phone_jid,
          $1,
          r.name,
          CASE
            WHEN r.phone_digits LIKE '91%' AND length(r.phone_digits) = 12
              THEN '+91 ' || substring(r.phone_digits, 3, 5) || ' ' || substring(r.phone_digits, 8, 5)
            ELSE '+' || r.phone_digits
          END,
          false,
          COALESCE(r.last_message, ''),
          r.last_time,
          COALESCE(r.unread, 0)
        FROM resolved r
        ON CONFLICT (id, account_phone) DO UPDATE SET
          name = COALESCE(
            CASE WHEN EXCLUDED.name ~* '^you$' THEN NULL ELSE EXCLUDED.name END,
            CASE WHEN wa_chats.name ~* '^you$' THEN NULL ELSE wa_chats.name END
          ),
          phone = COALESCE(EXCLUDED.phone, wa_chats.phone),
          last_message = CASE WHEN EXCLUDED.last_message != '' THEN EXCLUDED.last_message ELSE wa_chats.last_message END,
          last_time = GREATEST(COALESCE(EXCLUDED.last_time, wa_chats.last_time), COALESCE(wa_chats.last_time, EXCLUDED.last_time)),
          unread = GREATEST(wa_chats.unread, EXCLUDED.unread),
          updated_at = NOW()
        RETURNING 1
      ),
      deleted AS (
        DELETE FROM wa_chats c
        USING resolved r
        WHERE c.account_phone = $1 AND c.id = r.id
        RETURNING c.id
      )
      SELECT COUNT(*)::int AS merged FROM resolved
    `, [accPhone]);
    const merged = mergedRes.rows[0]?.merged || 0;

    await pool.query(`
      UPDATE wa_contacts SET phone = NULL, updated_at = NOW()
      WHERE account_phone = $1 AND jid LIKE '%@lid'
        AND (
          regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = split_part(jid, '@', 1)
          OR NOT (regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$')
        )
    `, [accPhone]);

    if (merged > 0) console.log(`[WA] Consolidated ${merged} @lid chats into phone JIDs (batch)`);
    return { merged };
  } catch (err) {
    console.error('[WA] consolidateLidChats error:', err.message);
    return { merged: 0 };
  }
}

// ── UPDATE CHAT NAMES AFTER CONTACTS SYNC ───────────────────────────────────────────
let isUpdatingChatNames = false;
let needsUpdateChatNames = false;
async function updateChatNames() {
  if (isUpdatingChatNames) {
    needsUpdateChatNames = true;
    return;
  }
  isUpdatingChatNames = true;
  try {
    do {
      needsUpdateChatNames = false;
      await _inner_updateChatNames();
    } while (needsUpdateChatNames);
  } catch(e) {
    console.error('[WA] updateChatNames wrapper error:', e.message);
  }
  isUpdatingChatNames = false;
}

async function _inner_updateChatNames() {
  try {
    const accPhone = phoneNumber;
    if (!accPhone) return;
    const chats = await pool.query(`SELECT id, phone, name, is_group FROM wa_chats WHERE account_phone=$1`, [accPhone]);
    let updated = 0;
    for (const chat of chats.rows) {
      if (chat.is_group || isLidJid(chat.id)) continue;
      const rawPhone = chat.id.split('@')[0].split(':')[0];
      if (!isAllowedWaNumber(rawPhone)) continue;
      const resolvedName = getContactName(chat.id, null);
      const displayPhone = formatDisplayPhone(rawPhone);
      if (resolvedName && resolvedName !== displayPhone && !/^\+?\d[\d\s]+$/.test(resolvedName)) {
        await pool.query(`UPDATE wa_chats SET name=$1, phone=$2 WHERE id=$3 AND account_phone=$4`, [resolvedName, displayPhone, chat.id, accPhone]);
        updated++;
      } else if (!chat.phone || chat.phone !== displayPhone) {
        await pool.query(`UPDATE wa_chats SET phone=$1 WHERE id=$2 AND account_phone=$3`, [displayPhone, chat.id, accPhone]);
      }
    }

    await pool.query(`
      UPDATE wa_chats
      SET phone = CASE
        WHEN wc.phone LIKE '91%' AND length(regexp_replace(wc.phone, '[^0-9]', '', 'g')) = 12
          THEN '+91 ' || substring(regexp_replace(wc.phone, '[^0-9]', '', 'g'), 3, 5) || ' ' || substring(regexp_replace(wc.phone, '[^0-9]', '', 'g'), 8, 5)
        WHEN wc.phone IS NOT NULL AND wc.phone != ''
          AND regexp_replace(wc.phone, '[^0-9]', '', 'g') != split_part(wa_chats.id, '@', 1)
          AND regexp_replace(wc.phone, '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$'
          THEN '+' || regexp_replace(wc.phone, '[^0-9]', '', 'g')
        ELSE wa_chats.phone
      END,
      name = CASE
        WHEN (wc.name IS NOT NULL AND wc.name != '' AND wc.name NOT LIKE '+%' AND length(regexp_replace(wc.name, '[^0-9]', '', 'g')) < 7)
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
        AND regexp_replace(wc.phone, '[^0-9]', '', 'g') != split_part(wa_chats.id, '@', 1)
        AND regexp_replace(wc.phone, '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$'
    `, [accPhone]);

    await cleanupContactLabels();
    await enrichContactNamesFromMessages();
    await consolidateLidChats();
    console.log('[WA] Updated ' + updated + ' chat names');
  } catch (err) {
    console.error('[WA] updateChatNames error:', err.message);
  }
}

async function countPendingLids(accPhone) {
  if (!accPhone) return 0;
  const r = await pool.query(`
    SELECT COUNT(DISTINCT jid)::int AS n FROM (
      -- LIDs in wa_contacts with no valid phone
      SELECT jid FROM wa_contacts
      WHERE account_phone = $1
        AND jid LIKE '%@lid'
        AND (
          COALESCE(regexp_replace(phone, '[^0-9]', '', 'g'), '') = ''
          OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = split_part(jid, '@', 1)
          OR NOT (regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$')
        )
      UNION
      -- LIDs in wa_chats with no valid phone
      SELECT id AS jid FROM wa_chats
      WHERE account_phone = $1
        AND id LIKE '%@lid'
        AND is_group = false
        AND (
          COALESCE(regexp_replace(phone, '[^0-9]', '', 'g'), '') = ''
          OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = split_part(id, '@', 1)
          OR NOT (regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$')
        )
    ) AS combined
  `, [accPhone]);
  return r.rows[0]?.n || 0;
}

async function refreshLidResolutionGroupIds(accPhone) {
  const dbGroups = await pool.query(
    `SELECT id FROM wa_chats WHERE account_phone=$1 AND is_group=true ORDER BY updated_at DESC NULLS LAST`,
    [accPhone]
  );
  lidResolutionGroupIds = [...new Set([
    ...dbGroups.rows.map(r => r.id),
    ...getSocketGroupIds(),
  ])];
  if (lidResolutionGroupCursor >= lidResolutionGroupIds.length) {
    lidResolutionGroupCursor = 0;
    lidResolutionExhausted = false;
  }
}

async function processLidResolutionBatch(batchSize = LID_RESOLUTION_BATCH_SIZE) {
  if (!sock || !isConnected) {
    return { skipped: true, reason: 'not_connected', pending: 0 };
  }
  if (lidResolutionCooldownUntil && Date.now() < lidResolutionCooldownUntil) {
    const minsLeft = Math.ceil((lidResolutionCooldownUntil - Date.now()) / 60000);
    return { skipped: true, reason: `cooldown (${minsLeft}m left)`, pending: await countPendingLids(phoneNumber) };
  }

  if (lidResolutionInFlight) {
    return { skipped: true, reason: 'in_flight', pending: await countPendingLids(phoneNumber) };
  }

  const accPhone = phoneNumber;
  if (!accPhone) return { skipped: true, reason: 'no_account', pending: 0 };

  lidResolutionInFlight = true;
  try {
    const beforePending = await countPendingLids(accPhone);
    if (beforePending === 0) {
      return { resolved: 0, pending: 0, groupsScanned: 0, batchSize };
    }

    // Ensure all @lid wa_chats entries exist in wa_contacts so we can update their phone
    await pool.query(`
      INSERT INTO wa_contacts (jid, account_phone, name, phone, is_group_member)
      SELECT id, account_phone, NULLIF(name,''), NULL, false
      FROM wa_chats
      WHERE account_phone=$1 AND id LIKE '%@lid' AND is_group=false
      ON CONFLICT (jid, account_phone) DO NOTHING
    `, [accPhone]);

    if (!lidResolutionGroupIds.length) await refreshLidResolutionGroupIds(accPhone);
    if (!lidResolutionGroupIds.length) {
      return { resolved: 0, pending: beforePending, groupsScanned: 0, batchSize };
    }

    const pendingContacts = [];
    const seenJids = new Set();
    let groupsScanned = 0;
    let hitRateLimit = false;

    while (
      groupsScanned < MAX_GROUPS_PER_LID_BATCH
      && lidResolutionGroupCursor < lidResolutionGroupIds.length
      && pendingContacts.length < batchSize * 4
    ) {
      const chunk = lidResolutionGroupIds.slice(
        lidResolutionGroupCursor,
        lidResolutionGroupCursor + GROUP_METADATA_CONCURRENCY
      );
      if (!chunk.length) break;
      lidResolutionGroupCursor += chunk.length;
      groupsScanned += chunk.length;

      try {
        await runWithConcurrency(chunk, GROUP_METADATA_CONCURRENCY, async (gid) => {
          // Skip if this JID is in rate-limit cooldown
          if ((groupMetadataRateCooldown.get(gid) || 0) > Date.now()) return;
          if (GROUP_METADATA_DELAY_MS > 0) await sleep(GROUP_METADATA_DELAY_MS);
           const meta = await getRawGroupMetadata(gid);
          for (const p of meta?.participants || []) {
            const lidJid = p.id?.endsWith('@lid') ? p.id : (p.lid || null);
            let phoneJid = p.id?.endsWith('@s.whatsapp.net') ? p.id : null;
            if (!phoneJid && p.phoneNumber) {
              phoneJid = typeof p.phoneNumber === 'string' ? p.phoneNumber : (p.phoneNumber.jid || null);
            }
            if (!lidJid || !phoneJid) continue;
            const rawPhone = String(phoneJid).split('@')[0].split(':')[0].replace(/\D/g, '');
            if (!rawPhone || !isAllowedWaNumber(rawPhone) || seenJids.has(lidJid)) continue;
            seenJids.add(lidJid);
            pendingContacts.push({
              jid: lidJid,
              name: p.name && !isInvalidContactLabel(p.name) ? p.name : (contactsStore[lidJid]?.name || null),
              phone: rawPhone,
            });
          }
        });
      } catch (err) {
        const errMsg = String(err?.message || '');
        if (errMsg.includes('timed out') || /rate.?overlimit|rate.?limit|429/i.test(errMsg)) {
          hitRateLimit = true;
          break;
        }
      }
    }

    if (hitRateLimit) {
      console.warn('[WA] Group metadata rate limit hit (timeout). Pausing LID resolution for 10 minutes.');
      lidResolutionCooldownUntil = Date.now() + 10 * 60 * 1000;
    }

    if (lidResolutionGroupCursor >= lidResolutionGroupIds.length && !hitRateLimit) {
      lidResolutionGroupCursor = 0;
      lidResolutionExhausted = true;
    }

    const upserted = await upsertGroupMemberContacts(pendingContacts, accPhone);
    await consolidateLidChats();
    await loadLidPhoneMapFromDB();

    const afterPending = await countPendingLids(accPhone);
    const resolved = Math.max(0, beforePending - afterPending);
    const result = {
      batchSize,
      groupsScanned,
      upserted,
      resolved,
      pending: afterPending,
    };

    if (resolved > 0 || upserted > 0) {
      emit('wa:lid_batch', result);
      emit('wa:participants_synced', { total: resolved || upserted, pending: afterPending, ...result });
    }

    console.log('[WA] LID resolution batch:', result);
    recordActivity('lid_batch', 'LID resolution batch', result);
    return result;
  } finally {
    lidResolutionInFlight = false;
  }
}

function stopLidResolutionWorker() {
  if (lidResolutionWorkerTimer) {
    clearTimeout(lidResolutionWorkerTimer);
    lidResolutionWorkerTimer = null;
  }
}

async function tickLidResolutionWorker() {
  if (!sock || !isConnected || !phoneNumber) {
    stopLidResolutionWorker();
    return;
  }
  try {
    if (isProcessingHistoryQueue || historySyncQueue.length > 0) {
      // Pause worker if history sync is active to prevent socket congestion
      lidResolutionWorkerTimer = setTimeout(tickLidResolutionWorker, LID_RESOLUTION_BATCH_DELAY_MS);
      return;
    }

    const pending = await countPendingLids(phoneNumber);
    if (pending === 0) {
      console.log('[WA] LID resolution worker complete');
      stopLidResolutionWorker();
      emit('wa:lid_resolution_complete', {});
      return;
    }
    if (lidResolutionExhausted) {
      // Still have unresolved LIDs — but if we resolved nothing in the last pass, WA has no more data for us
      const resolved = lidResolutionLastPassResolved || 0;
      if (resolved === 0) {
        console.log(`[WA] LID resolution: full pass with 0 new resolutions — ${pending} LIDs unresolvable from available group data. Stopping worker.`);
        stopLidResolutionWorker();
        return;
      }
      console.log(`[WA] LID resolution exhausted pass, ${pending} still pending — resetting for another pass`);
      lidResolutionExhausted = false;
      lidResolutionGroupCursor = 0;
      lidResolutionGroupIds = [];
      lidResolutionLastPassResolved = 0;
      lidResolutionWorkerTimer = setTimeout(tickLidResolutionWorker, 60 * 1000);
      return;
    }
    const batchResult = await processLidResolutionBatch(LID_RESOLUTION_BATCH_SIZE);
    if (batchResult && batchResult.resolved) lidResolutionLastPassResolved += batchResult.resolved;
  } catch (err) {
    console.warn('[WA] LID resolution worker tick failed:', err.message);
  }
  // If a cooldown is active, wait it out instead of hammering every 2.5s
  const cooldownWait = lidResolutionCooldownUntil > Date.now()
    ? Math.min(lidResolutionCooldownUntil - Date.now() + 2000, 15 * 60 * 1000)
    : LID_RESOLUTION_BATCH_DELAY_MS;
  lidResolutionWorkerTimer = setTimeout(tickLidResolutionWorker, cooldownWait);
}

function startLidResolutionWorker() {
  stopLidResolutionWorker();
  lidResolutionGroupCursor = 0;
  lidResolutionGroupIds = [];
  lidResolutionLastPassResolved = 0;
  console.log('[WA] Starting LID resolution worker (batch size ' + LID_RESOLUTION_BATCH_SIZE + ')');
  lidResolutionWorkerTimer = setTimeout(tickLidResolutionWorker, 1500);
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
    const accPhone = phoneNumber;
    if (!accPhone) return;
    let groupIds = (await pool.query(`SELECT id FROM wa_chats WHERE is_group = true AND account_phone=$1`, [accPhone])).rows.map(r => r.id);
    if (!groupIds.length) groupIds = getSocketGroupIds();
    if (!groupIds.length) return;
    const groups = { rows: groupIds.map(id => ({ id })) };
    console.log(`[WA] Syncing participants for ${groups.rows.length} groups (batch)...`);
    recordActivity('participants', 'Group participant sync started', { groups: groups.rows.length });
    const pendingContacts = [];
    let total = 0;

    await runWithConcurrency(groups.rows, GROUP_METADATA_CONCURRENCY, async (group) => {
      if (!isConnected || phoneNumber !== accPhone) return;
      try {
        if (GROUP_METADATA_DELAY_MS > 0) await new Promise(resolve => setTimeout(resolve, GROUP_METADATA_DELAY_MS));
        const meta = await sock.groupMetadata(group.id);
        for (const p of meta.participants || []) {
          const lidJid = p.id?.endsWith('@lid') ? p.id : (p.lid || null);
          let phoneJid = p.id?.endsWith('@s.whatsapp.net') ? p.id : null;
          if (!phoneJid && p.phoneNumber) {
            phoneJid = typeof p.phoneNumber === 'string' ? p.phoneNumber : (p.phoneNumber.jid || null);
          }
          if (!lidJid || !phoneJid) continue;
          const rawPhone = String(phoneJid).split('@')[0].split(':')[0].replace(/\D/g, '');
          if (!rawPhone || !isAllowedWaNumber(rawPhone) || seenJids.has(lidJid)) continue;
          seenJids.add(lidJid);
          pendingContacts.push({ jid: lidJid, name: null, phone: rawPhone });
        }
      } catch (_) { }
    });

    total = await upsertGroupMemberContacts(pendingContacts, accPhone);
    await consolidateLidChats();
    await loadLidPhoneMapFromDB();
    console.log(`[WA] ✅ Group participant sync done — ${total} LID→phone entries saved`);
    recordActivity('participants', 'Group participant sync complete', { total });
    lastGroupParticipantSyncAt = Date.now();
    emit('wa:participants_synced', { total });
    startLidResolutionWorker();
  } catch (err) {
    console.error('[WA] syncAllGroupParticipants error:', err.message);
    recordActivity('error', 'Group participant sync failed', { error: err.message });
  } finally {
    groupParticipantSyncing = false;
  }
}

// ── RESET & FRESH SYNC GROUP CONTACTS ────────────────────────────────────────────────
// Wipes all group-member contacts from DB + memory, then re-syncs fresh from live Baileys.
// Does NOT touch WA session, individual chats, or messages.
async function resetAndResyncGroupContacts() {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('No connected account');

  // 1. Wipe group-member contacts from DB
  const deleted = await pool.query(
    `DELETE FROM wa_contacts WHERE account_phone=$1 AND is_group_member=true`,
    [accPhone]
  );
  console.log(`[WA] Reset: deleted ${deleted.rowCount} group-member contacts from DB`);

  // 2. Remove group-member entries from in-memory contactsStore
  for (const [key, entry] of Object.entries(contactsStore)) {
    if (entry?.is_group_member) delete contactsStore[key];
  }

  // 3. Clear group metadata caches so fresh data is fetched
  groupMetadataCache.clear();
  rawGroupMetadataCache.clear();

  // 4. Reset LID resolution state so it re-scans everything
  lastGroupParticipantSyncAt = 0;
  lidResolutionGroupIds = [];
  lidResolutionGroupCursor = 0;
  lidResolutionExhausted = false;

  // 5. Fresh sync: fetch ALL group participants from live Baileys socket
  // Capture LID-only members too (with name/notify), not just LID+phone pairs
  const groupIds = [...new Set([
    ...(await pool.query(`SELECT id FROM wa_chats WHERE is_group=true AND account_phone=$1`, [accPhone])).rows.map(r => r.id),
    ...getSocketGroupIds(),
  ])];

  console.log(`[WA] Reset: re-syncing ${groupIds.length} groups fresh from Baileys...`);
  const allContacts = [];
  const seenJids = new Set();

  await runWithConcurrency(groupIds.map(id => ({ id })), GROUP_METADATA_CONCURRENCY, async (group) => {
    if (!isConnected) return;
    try {
      if (GROUP_METADATA_DELAY_MS > 0) await new Promise(r => setTimeout(r, GROUP_METADATA_DELAY_MS));
      const meta = await sock.groupMetadata(group.id);
      for (const p of meta.participants || []) {
        const pJid = p.id;
        if (!pJid || seenJids.has(pJid)) continue;
        seenJids.add(pJid);
        // Extract phone if available
        let phone = null;
        if (pJid.endsWith('@s.whatsapp.net')) {
          phone = pJid.split('@')[0].split(':')[0];
        } else if (p.phoneNumber) {
          const pn = typeof p.phoneNumber === 'string' ? p.phoneNumber : (p.phoneNumber.jid || '');
          const digits = pn.split('@')[0].replace(/\D/g, '');
          if (isAllowedWaNumber(digits)) phone = digits;
        }
        const name = (!pJid.endsWith('@lid') && p.name && !isInvalidContactLabel(p.name)) ? p.name : null;
        allContacts.push({ jid: pJid, name, phone });
      }
    } catch (_) {}
  });

  const saved = await upsertGroupMemberContacts(allContacts, accPhone);
  await consolidateLidChats();
  await loadLidPhoneMapFromDB();
  console.log(`[WA] Reset: fresh sync complete — ${saved} group contacts saved (${allContacts.filter(c => c.phone).length} with phones, ${allContacts.filter(c => !c.phone).length} LID-only)`);
  recordActivity('participants', 'Group contacts reset + fresh sync', { saved, groups: groupIds.length });
  emit('wa:participants_synced', { total: saved, reset: true });
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
async function sendMessage(jid, text, quotedMsgId) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const formattedJid = formatJid(jid);
  const socketJid = getSocketJid(formattedJid);
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('Connected WhatsApp account is not known yet');

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
            remoteJid: socketJid,
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

  const result = await sock.sendMessage(socketJid, sendContent, sendOptions);
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
  pushLiveMessage(formattedJid, {
    id: savedMsg.id,
    chat_id: formattedJid,
    account_phone: accPhone,
    from_me: true,
    sender_name: 'You',
    body: text,
    msg_type: 'text',
    timestamp: ts.toISOString(),
    is_read: true,
    status: 'sent',
    quoted_body: savedMsg.quotedBody,
    is_reply: !!quotedMsgId,
    reply_to_msg_id: quotedMsgId || null,
  });
  await saveChat(formattedJid, null, text, ts, 0, formattedJid.endsWith('@g.us'));

  // Ensure the contact appears in WA Contacts directory
  if (!formattedJid.endsWith('@g.us')) {
    const digits = formattedJid.split('@')[0];
    const phone = '+' + digits;
    saveContact({ jid: formattedJid, id: formattedJid, name: phone, notify: phone, phones: [{ phone }], verifiedName: null, isBusiness: false }).catch(() => {});
  }

  emit('wa:message', savedMsg);
  return savedMsg;
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
  const socketJid = getSocketJid(formattedJid);
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('Connected WhatsApp account is not known yet');
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
            remoteJid: socketJid,
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
    console.log(`[WA] Attempting combined send of ${finalType} to ${socketJid} with caption: "${caption || ''}"`);
    result = await sendPreparedMedia(socketJid, finalType, finalBuffer, finalMimetype, filename, caption, quoted);
    console.log(`[WA] Send successful, ID: ${result?.key?.id}`);
  } catch (err) {
    console.error(`[WA] Combined send failed for ${finalType}:`, err.message);

    // Fallback: If combined fails, try file only to at least deliver the content
    console.warn(`[WA] Falling back to file-only transmission...`);
    try {
      result = await sendPreparedMedia(socketJid, finalType, finalBuffer, finalMimetype, filename, null, quoted);
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
  const mediaDir = MEDIA_DIR;
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
  pushLiveMessage(formattedJid, {
    id,
    chat_id: formattedJid,
    account_phone: accPhone,
    from_me: true,
    sender_name: 'You',
    body,
    msg_type: finalType,
    timestamp: ts.toISOString(),
    is_read: true,
    status: 'sent',
    quoted_body: savedMsg.quotedBody,
    is_reply: !!quotedMsgId,
    reply_to_msg_id: quotedMsgId || null,
    media_path: savedName,
  });
  await saveChat(formattedJid, null, body, ts, 0, formattedJid.endsWith('@g.us'));

  emit('wa:message', savedMsg);
  return savedMsg;
}

// ── GROUP METADATA ───────────────────────────────────────────────────────────
const groupMetadataRateCooldown = new Map(); // jid → cooldown-until timestamp
const GROUP_METADATA_RATE_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown after rate-limit
const groupMetadataInFlight = new Map(); // jid → Promise (dedup concurrent calls)

async function getRawGroupMetadata(jid) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const CACHE_TTL = 15 * 60 * 1000;
  const cached = rawGroupMetadataCache.get(jid);
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) return cached.data;

  // If this group is in rate-limit cooldown, serve cached data or throw
  const cooldownUntil = groupMetadataRateCooldown.get(jid) || 0;
  if (Date.now() < cooldownUntil) {
    if (cached) return cached.data;
    const waitSecs = Math.ceil((cooldownUntil - Date.now()) / 1000);
    throw new Error(`rate-overlimit: group metadata cooldown for ${waitSecs}s`);
  }

  // Dedup: if a fetch for this JID is already in-flight, wait for it instead of spawning a second
  if (groupMetadataInFlight.has(jid)) return groupMetadataInFlight.get(jid);

  let resolveInFlight, rejectInFlight;
  const inFlightPromise = new Promise((res, rej) => { resolveInFlight = res; rejectInFlight = rej; });
  inFlightPromise.catch(() => {}); // suppress unhandled rejection
  groupMetadataInFlight.set(jid, inFlightPromise);

  let meta;
  try {
    meta = await sock.groupMetadata(jid);
  } catch (err) {
    groupMetadataInFlight.delete(jid);
    const msg = String(err?.message || err || '');
    if (/rate.?overlimit|rate.?limit|429/i.test(msg)) {
      groupMetadataRateCooldown.set(jid, Date.now() + GROUP_METADATA_RATE_COOLDOWN_MS);
      console.warn(`[WA] Rate-overlimit for group ${jid} — cooldown ${GROUP_METADATA_RATE_COOLDOWN_MS / 1000}s`);
      if (cached) { resolveInFlight(cached.data); return cached.data; }
    }
    rejectInFlight(err);
    throw err;
  }

  // Baileys can return an error-like object instead of throwing — detect it
  if (!meta || typeof meta !== 'object' || /rate.?overlimit|rate.?limit/i.test(String(meta?.message || ''))) {
    groupMetadataInFlight.delete(jid);
    groupMetadataRateCooldown.set(jid, Date.now() + GROUP_METADATA_RATE_COOLDOWN_MS);
    console.warn(`[WA] Rate-overlimit object for group ${jid} — cooldown applied`);
    if (cached) { resolveInFlight(cached.data); return cached.data; }
    const rlErr = new Error('rate-overlimit: WhatsApp rate limit hit for group metadata');
    rejectInFlight(rlErr);
    throw rlErr;
  }

  rawGroupMetadataCache.set(jid, { ts: Date.now(), data: meta });
  groupMetadataInFlight.delete(jid);
  resolveInFlight(meta);
  return meta;
}

async function getGroupMetadata(jid, opts = {}) {
  const meta = await getRawGroupMetadata(jid);
  const CACHE_TTL = 15 * 60 * 1000;
  const cacheKey = `${jid}::all`;
  const cached = groupMetadataCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) return cached.data;

  const allParticipants = Array.isArray(meta.participants) ? meta.participants : [];
  // Deduplicate by JID — Baileys can return duplicates for large groups
  const seenJids = new Set();
  const uniqueParticipants = allParticipants.filter(p => {
    if (!p?.id || seenJids.has(p.id)) return false;
    seenJids.add(p.id);
    return true;
  });
  const totalParticipants = uniqueParticipants.length;

  const processedParticipants = uniqueParticipants.map(p => {
    const pJid = p.id;
    const phoneJid = p.phoneNumber || (pJid.endsWith('@lid') ? null : pJid);
    const rawPhone = phoneJid ? phoneJid.split('@')[0].split(':')[0] : '';
    const realJid = phoneJid || pJid;
    const stored = contactsStore[realJid] || contactsStore[pJid];
    // For @lid with no phoneNumber from Baileys, fall back to stored phone from DB
    const resolvedRawPhone = rawPhone || (stored?.phone ? stored.phone.replace(/\D/g, '') : '');
    let phoneDisplay = '';
    if (resolvedRawPhone && isAllowedWaNumber(resolvedRawPhone)) {
      phoneDisplay = resolvedRawPhone.startsWith('91') && resolvedRawPhone.length === 12
        ? '+91 ' + resolvedRawPhone.slice(2, 7) + ' ' + resolvedRawPhone.slice(7)
        : resolvedRawPhone.startsWith('0')
          ? resolvedRawPhone
          : '+' + resolvedRawPhone;
    }
    // For @lid: p.name from groupMetadata is unreliable (maps via local contactsStore, bleeds wrong names).
    // Only trust stored.notify (delivered per-JID by WA server via contacts.upsert) and phone display.
    let displayName = null;
    if (!pJid.endsWith('@lid')) {
      // Regular phone JID — p.name is fine
      displayName = (p.name && !isInvalidContactLabel(p.name)) ? p.name : null;
    }
    if (!displayName) {
      const storedNotify = stored?.notify || null;
      if (storedNotify && !isInvalidContactLabel(storedNotify)) {
        displayName = storedNotify;
      } else if (!pJid.endsWith('@lid') || phoneDisplay) {
        const storedName = stored?.name || null;
        if (storedName && !isInvalidContactLabel(storedName)) displayName = storedName;
      }
    }
    displayName = displayName || phoneDisplay || null;
    return { jid: pJid, phone: phoneDisplay, name: displayName, admin: p.admin === 'admin' || p.admin === 'superadmin' };
  });

  const result = {
    id: meta.id,
    name: meta.subject,
    description: meta.desc || '',
    participants: processedParticipants,
    total_participants: totalParticipants,
    has_more: false,
    announce: meta.announce === true,
  };
  groupMetadataCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

function getSocketGroupIds() {
  const ids = new Set();
  for (const chat of liveChatsStore.values()) {
    if (chat?.id?.endsWith('@g.us')) ids.add(chat.id);
  }
  for (const chat of getSocketChatsSnapshot()) {
    if (chat?.id?.endsWith('@g.us')) ids.add(chat.id);
  }
  return [...ids];
}

async function countAccountChats(accPhone) {
  if (!accPhone) return 0;
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM wa_chats WHERE account_phone=$1`, [accPhone]);
  return parseInt(r.rows[0]?.n || 0, 10);
}

/**
 * Rebuild wa_chats / wa_contacts from the live Baileys socket store.
 * Needed after DB purge while still connected — messaging-history.set does not replay.
 */
async function resyncDirectoryFromSocket(options = {}) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('Connected WhatsApp account is not known yet');

  // Removed crashing sock.resyncAppState call. We rebuild from the in-memory store instead.

  const rawChats = getSocketChatsSnapshot();
  let chatsSaved = 0;
  let contactsSaved = 0;

  for (const entry of Object.values(contactsStore)) {
    if (!entry?.id) continue;
    await saveContact({
      id: entry.id,
      name: entry.name,
      notify: entry.notify,
      phoneNumber: entry.phoneJid || (entry.phone ? `${entry.phone}@s.whatsapp.net` : undefined),
    });
    contactsSaved++;
  }

  for (const chat of rawChats) {
    if (!chat?.id || isNonChatJid(chat.id)) continue;
    const isGroup = chat.id.endsWith('@g.us');
    const name = isGroup
      ? (chat.subject || chat.name || null)
      : getContactName(chat.id, chat.name || chat.notify);
    const ts = toDate(chat.conversationTimestamp);
    await saveChat(chat.id, name, '', ts, Number(chat.unreadCount || 0), isGroup, { unreadMode: 'set' });
    chatsSaved++;
  }

  liveChatsStore.clear();

  await updateChatNames();
  await enrichContactNamesFromMessages();
  let consolidated = await consolidateLidChats();
  await loadLidPhoneMapFromDB();

  const dbGroups = await pool.query(
    `SELECT id FROM wa_chats WHERE account_phone=$1 AND is_group=true`,
    [accPhone]
  );
  const groupIds = [...new Set([
    ...dbGroups.rows.map(r => r.id),
    ...getSocketGroupIds(),
  ])];

  const groupLimit = Math.min(groupIds.length, Math.max(1, parseInt(options.groupLimit, 10) || 100));
  const targetGroups = groupIds.slice(0, groupLimit);
  const pendingContacts = [];
  let lidUpdated = 0;

  await runWithConcurrency(targetGroups, GROUP_METADATA_CONCURRENCY, async (gid) => {
    try {
      if (GROUP_METADATA_DELAY_MS > 0) await sleep(GROUP_METADATA_DELAY_MS);
      const meta = await sock.groupMetadata(gid);
      if (meta?.subject) {
        await saveChat(gid, meta.subject, '', null, 0, true);
      }
      for (const p of meta?.participants || []) {
        if (!p.id) continue;
        const pNum = typeof p.phoneNumber === 'string' ? p.phoneNumber : (p.phoneNumber?.jid || '');
        const rawPhone = String(pNum || '').replace(/\D/g, '');
        const contactName = p.name && !isInvalidContactLabel(p.name) ? p.name : null;
        if (p.id.endsWith('@lid') && rawPhone && isAllowedWaNumber(rawPhone)) {
          pendingContacts.push({ jid: p.id, name: contactName, phone: rawPhone });
          lidUpdated++;
        } else {
          await saveContact({
            id: p.id,
            name: contactName,
            phoneNumber: pNum || undefined,
          });
        }
      }
    } catch (err) {
      console.warn(`[WA] resync group metadata skipped for ${gid}:`, err.message);
    }
  });
  await upsertGroupMemberContacts(pendingContacts, accPhone);

  await updateChatNames();
  consolidated = await consolidateLidChats();
  await loadLidPhoneMapFromDB();

  const result = {
    socket_chats: rawChats.length,
    chats_saved: chatsSaved,
    contacts_saved: contactsSaved,
    groups_scanned: groupLimit,
    lid_contacts_updated: lidUpdated,
    lid_chats_merged: consolidated.merged || 0,
    db_chats: await countAccountChats(accPhone),
  };
  console.log('[WA] Directory resync from socket:', result);
  recordActivity('resync', 'Directory resync from socket', result);
  emit('wa:sync_complete', result);
  return result;
}

async function refreshCurrentAccountGroupMetadata(limit = 25) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  // Skip if LID resolution worker is actively running — they compete for the same WA quota
  if (lidResolutionInFlight) return { skipped: true, reason: 'lid_worker_in_flight' };
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('Connected WhatsApp account is not known yet');
  const maxGroups = Math.max(1, Math.min(parseInt(limit, 10) || 25, 100));
  let groupIds = (await pool.query(`
    SELECT id, name
    FROM wa_chats
    WHERE account_phone=$1
      AND is_group=true
    ORDER BY
      (name IS NULL OR name = '' OR name ~ '^[0-9]{10,}$') DESC,
      updated_at DESC NULLS LAST, last_time DESC NULLS LAST
    LIMIT $2
  `, [accPhone, maxGroups])).rows.map(r => r.id);

  if (!groupIds.length) {
    groupIds = getSocketGroupIds().slice(0, maxGroups);
  }

  const groups = { rows: groupIds.map(id => ({ id, name: null })) };

  let groupsUpdated = 0;
  const pendingContacts = [];

  await runWithConcurrency(groups.rows, GROUP_METADATA_CONCURRENCY, async (row) => {
    try {
      // Skip if this JID is in rate-limit cooldown
      if ((groupMetadataRateCooldown.get(row.id) || 0) > Date.now()) return;
      if (GROUP_METADATA_DELAY_MS > 0) await new Promise(resolve => setTimeout(resolve, GROUP_METADATA_DELAY_MS));
      const meta = await getRawGroupMetadata(row.id);
      if (meta?.subject) {
        await pool.query(
          `UPDATE wa_chats SET name=$1, updated_at=NOW() WHERE id=$2 AND account_phone=$3`,
          [meta.subject, row.id, accPhone]
        );
        contactsStore[row.id] = { id: row.id, name: meta.subject };
        groupsUpdated++;
      }

      for (const p of meta?.participants || []) {
        if (!p.id || !p.id.endsWith('@lid') || !p.phoneNumber) continue;
        const pNum = typeof p.phoneNumber === 'string' ? p.phoneNumber : (p.phoneNumber?.jid || '');
        const rawPhone = pNum.replace(/\D/g, '');
        if (!rawPhone || !isAllowedWaNumber(rawPhone)) continue;
        pendingContacts.push({ jid: p.id, name: null, phone: rawPhone });
      }
    } catch (err) {
      const errMsg = String(err?.message || '');
      if (!errMsg.includes('rate-overlimit')) {
        console.warn(`[WA] Group metadata refresh skipped for ${row.id}:`, err.message);
      }
    }
  });

  const contactsUpdated = await upsertGroupMemberContacts(pendingContacts, accPhone);

  await updateChatNames();
  await consolidateLidChats();
  emit('wa:participants_synced', { total: contactsUpdated });
  return { groups_checked: groups.rows.length, groups_updated: groupsUpdated, lid_contacts_updated: contactsUpdated };
}

// ── MEDIA DOWNLOAD ────────────────────────────────────────────────────────────
const msgCache = new Map();
const MAX_CACHE = 500;

async function downloadMedia(msgId) {
  const mediaDir = MEDIA_DIR;
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
  stopLidResolutionWorker();
  stopWatchdog();
  allowQrGeneration = false;
  currentState = 'DISCONNECTED';
  // Cancel any pending reconnect so WA never auto-restarts after explicit logout
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  hasConnectedBefore = false; // reset so next connect is treated as fresh
  if (sock) {
    const s = sock;
    sock = null; // null first to prevent event handlers from referencing it
    isConnected = false;
    try { s.ev.removeAllListeners(); } catch (_) { }
    try { await s.logout(); } catch (e) { console.warn('[WA] Logout error:', e.message); }
    try { s.end?.(); } catch (_) { }
    qrString = null;
    pairingCode = null;
    pairingPhone = null;
    phoneNumber = null;
    userJid = null;
    userLid = null;
    clearContactsStore();
    liveChatsStore.clear();
    liveMessagesStore.clear();
    importedLastTsMap = {};
    groupMetadataCache.clear();
    rawGroupMetadataCache.clear();
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
    hasPairingCode: !!pairingCode,
    pairingPhone,
    hasSession: hasSavedSession(),
    state: currentState,
    activity: activityBuffer[activityBuffer.length - 1] || null,
    recent_activity: activityBuffer.slice(-40),
  };
}

async function getQR() {
  if (!qrString) return null;
  return qrcode.toDataURL(qrString);
}

async function requestQR() {
  allowQrGeneration = true;
  pairingCode = null;
  pairingPhone = null;
  recordActivity('qr', 'QR requested');

  // Cancel any pending reconnect timer — we're taking over
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;

  // If already connected, nothing to do — QR only makes sense when disconnected
  if (isConnected) return getQR();

  // Kill existing socket immediately so startWA creates a clean one
  if (sock && !isConnected) {
    const old = sock;
    sock = null;
    startInProgress = false;
    try { old.ev.removeAllListeners(); } catch (_) { }
    try { old.end?.(); } catch (_) { }
  }

  // Start fresh with QR allowed
  await startWA({ allowQR: true });

  // Wait up to 20s for QR (usually arrives in < 3s on a clean start)
  const startedAt = Date.now();
  while (!qrString && !isConnected && Date.now() - startedAt < 20000) {
    await sleep(250);
  }

  return getQR();
}

function normalizePairingPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  if (digits.startsWith('0') && digits.length > 10) digits = digits.replace(/^0+/, '');
  if (!isAllowedWaNumber(digits)) return '';
  return digits;
}

async function requestPhonePairingCode(value) {
  const phone = normalizePairingPhone(value);
  if (!phone) throw new Error('Enter a valid WhatsApp phone number with country code');
  if (isConnected) throw new Error('WhatsApp is already connected');

  allowQrGeneration = true;
  pairingCode = null;
  pairingPhone = phone;
  recordActivity('pairing', 'Phone pairing code requested', { phone });

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (!sock || startInProgress) {
    await startWA({ allowQR: true });
  }

  const startedAt = Date.now();
  while (!sock && !isConnected && Date.now() - startedAt < 15000) {
    await sleep(250);
  }

  if (!sock) throw new Error('WhatsApp socket is not ready yet');
  if (isConnected) throw new Error('WhatsApp is already connected');
  if (typeof sock.requestPairingCode !== 'function') {
    throw new Error('Phone-number pairing is not supported by this WhatsApp engine version');
  }

  const code = await sock.requestPairingCode(phone);
  pairingCode = String(code || '').trim();
  if (!pairingCode) throw new Error('Could not generate pairing code');
  recordActivity('pairing', 'Phone pairing code generated', { phone });
  emit('wa:pairing_code', { phone, code: pairingCode });
  return { phone, code: pairingCode };
}

function getConnectedPhone() {
  if (!isConnected || currentState !== 'CONNECTED') return null;
  return phoneNumber;
}

async function loadImportedCheckpointsFromDB() {
  try {
    importedLastTsMap = {};
    const accPhone = phoneNumber;
    if (!accPhone) return;
    const res = await pool.query(
      `SELECT id, imported_last_ts FROM wa_chats WHERE account_phone=$1 AND imported_last_ts IS NOT NULL`,
      [accPhone]
    );
    for (const r of res.rows) {
      importedLastTsMap[r.id] = new Date(r.imported_last_ts).getTime();
    }
  } catch (err) {
    console.warn('[WA] Imported checkpoint preload skipped:', err.message);
  }
}

// ── IMPORT ────────────────────────────────────────────────────────────────────
async function importExportedChat(chatText, chatJid, mediaFiles, clearOld) {
  if (!chatJid) throw new Error("A valid chat must be selected.");
  await ensureTables();
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('WhatsApp must be connected before importing a chat.');
  const existing = await pool.query(`SELECT id, name FROM wa_chats WHERE id=$1 AND account_phone=$2`, [chatJid, accPhone]);
  if (existing.rows.length === 0) throw new Error("Chat not found.");
  const displayChatName = existing.rows[0].name;

  if (clearOld) await pool.query(`DELETE FROM wa_messages WHERE chat_id=$1 AND account_phone=$2`, [chatJid, accPhone]);

  const mediaDir = MEDIA_DIR;
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

function getLiveChats() {
  if (!liveChatsStore.size && sock && sock.chats) {
    const rawChats = getSocketChatsSnapshot();
    for (const c of rawChats) {
      if (!c?.id || c.id === 'status@broadcast') continue;
      const isGroup = c.id.endsWith('@g.us');
      const lastTs = toDate(c.conversationTimestamp);
      const chatName = isGroup ? (c.subject || c.name || null) : getContactName(c.id, c.name || c.notify);
      updateLiveChatRow({
        id: c.id,
        name: chatName,
        phone: isGroup ? null : waFormatPhoneFromJid(c.id),
        is_group: isGroup,
        last_message: '',
        last_time: lastTs || null,
        unread: Number(c.unreadCount || 0),
      });
    }
  }
  return Array.from(liveChatsStore.values()).sort((a, b) => {
    const ta = a.last_time ? new Date(a.last_time).getTime() : 0;
    const tb = b.last_time ? new Date(b.last_time).getTime() : 0;
    return tb - ta;
  });
}

function getSocketChatsSnapshot() {
  // Baileys 7 no longer exposes sock.chats — use in-memory live store populated by events.
  if (liveChatsStore.size) {
    return Array.from(liveChatsStore.values()).map(row => ({
      id: row.id,
      name: row.name,
      conversationTimestamp: row.last_time,
      unreadCount: row.unread,
    }));
  }
  if (!sock || !sock.chats) return [];
  const source = sock.chats;
  try {
    if (Array.isArray(source)) return source;
    if (source instanceof Map) return Array.from(source.values());
    if (typeof source.all === 'function') {
      const fromAll = source.all();
      if (Array.isArray(fromAll)) return fromAll;
    }
    if (typeof source.values === 'function') {
      const values = source.values();
      if (Array.isArray(values)) return values;
      if (values && typeof values[Symbol.iterator] === 'function') return Array.from(values);
    }
    if (typeof source.toJSON === 'function') {
      const asJson = source.toJSON();
      if (Array.isArray(asJson)) return asJson;
      if (asJson && Array.isArray(asJson.chats)) return asJson.chats;
    }
    return Object.values(source || {});
  } catch (_) {
    return [];
  }
}

function getLiveMessages(jid, opts = {}) {
  const key = formatJid(jid);
  const limit = Math.min(Math.max(parseInt(opts.limit || 100, 10) || 100, 1), 200);
  const before = opts.before ? new Date(String(opts.before)) : null;
  const beforeTs = before && !Number.isNaN(before.getTime()) ? before.getTime() : null;
  let rows = (liveMessagesStore.get(key) || []).slice();
  if (!rows.length && msgCache.size) {
    const fallback = [];
    for (const cached of msgCache.values()) {
      const remote = formatJid(cached?.key?.remoteJid || '');
      if (remote !== key) continue;
      const ts = toDate(cached?.messageTimestamp) || new Date();
      fallback.push({
        id: cached?.key?.id || ('local_' + Date.now()),
        chat_id: key,
        account_phone: phoneNumber,
        from_me: !!cached?.key?.fromMe,
        sender: cached?.key?.participant || null,
        sender_name: cached?.pushName || null,
        body: getBody(cached),
        msg_type: getContentType(cached.message) || 'text',
        timestamp: ts.toISOString(),
        is_read: !!cached?.key?.fromMe,
        status: cached?.status ? waStatusLabel(cached.status) : (!!cached?.key?.fromMe ? 'sent' : null),
        quoted_body: getQuotedBody(cached),
        is_reply: false,
        reply_to_msg_id: null,
        media_path: cached?.mediaPath || null,
        sender_phone: null,
      });
    }
    if (fallback.length) {
      fallback.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      liveMessagesStore.set(key, fallback);
      rows = fallback.slice();
    }
  }
  if (beforeTs) {
    rows = rows.filter(m => {
      const ts = new Date(m.timestamp).getTime();
      return Number.isFinite(ts) && ts < beforeTs;
    });
  }
  rows = rows.slice(-limit);
  return rows;
}

function waFormatPhoneFromJid(jid) {
  const digits = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('91') && digits.length === 12) return '+91 ' + digits.slice(2, 7) + ' ' + digits.slice(7);
  return '+' + digits;
}

/**
 * Persist a group's real subject into wa_chats and notify the frontend.
 * Called whenever we get a confirmed name from groupMetadata (Group Info panel).
 */
async function updateGroupName(jid, subject, accPhone) {
  if (!jid || !subject || !accPhone) return;
  if (isInvalidContactLabel(subject)) return;
  try {
    await pool.query(
      `UPDATE wa_chats SET name=$1, updated_at=NOW() WHERE id=$2 AND account_phone=$3`,
      [subject, jid, accPhone]
    );
    // Keep in-memory store in sync
    if (contactsStore[jid]) contactsStore[jid].name = subject;
    else contactsStore[jid] = { id: jid, name: subject };
    // Push live update so chat list re-renders with the correct name
    emit('wa:chats_updated', {});
  } catch (err) {
    console.warn(`[WA] updateGroupName error for ${jid}:`, err.message);
  }
}

// Download all cached media messages to disk so backup can include them
async function flushCachedMediaToDisk() {
  const mediaDir = MEDIA_DIR;
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
  const extMap = { imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg', stickerMessage: 'webp', documentMessage: 'bin' };
  let saved = 0;
  for (const [msgId, msg] of msgCache.entries()) {
    const mtype = getContentType(msg.message);
    if (!mediaTypes.includes(mtype)) continue;
    const existingFiles = fs.readdirSync(mediaDir).filter(f => f.startsWith(msgId + '_'));
    if (existingFiles.length > 0) continue; // already on disk
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {});
      const ext = extMap[mtype] || 'bin';
      const docMsg = msg.message.documentMessage;
      const fname = docMsg?.fileName || `${msgId}.${ext}`;
      const savedName = msgId + '_' + fname;
      fs.writeFileSync(path.join(mediaDir, savedName), buf);
      // Also update DB so media_path is set
      if (phoneNumber) {
        pool.query(`UPDATE wa_messages SET media_path=$1 WHERE id=$2 AND account_phone=$3`, [savedName, msgId, phoneNumber]).catch(() => {});
      }
      saved++;
    } catch (_) {}
  }
  console.log(`[WA] flushCachedMediaToDisk: ${saved} media files saved`);
  return saved;
}

function getGroupSubjectFromCache(jid) {
  // Check contactsStore first (updated by groups.upsert/update events)
  const stored = contactsStore[jid];
  if (stored?.name && typeof stored.name === 'string' && stored.name.trim()) return stored.name.trim();
  // Check groupMetadataCache (populated by getGroupMetadata calls)
  for (const [key, val] of groupMetadataCache) {
    if (key.startsWith(jid + '::') && val?.data?.subject) return val.data.subject;
  }
  return null;
}

// ── PROFILE PICTURE ──────────────────────────────────────────────────────────
const profilePicCache = new Map(); // jid → { url, ts }
const PROFILE_PIC_TTL = 24 * 60 * 60 * 1000; // 24h

async function getProfilePicUrl(jid, accPhone) {
  const cached = profilePicCache.get(jid);
  if (cached && Date.now() - cached.ts < PROFILE_PIC_TTL) return cached.url;

  // Try DB first
  const dbRow = await pool.query(
    `SELECT profile_pic_url FROM wa_chats WHERE id=$1 AND account_phone=$2 LIMIT 1`,
    [jid, accPhone]
  );
  if (dbRow.rows[0]?.profile_pic_url) {
    profilePicCache.set(jid, { url: dbRow.rows[0].profile_pic_url, ts: Date.now() });
    return dbRow.rows[0].profile_pic_url;
  }

  if (!sock || !isConnected) return null;
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    if (url) {
      profilePicCache.set(jid, { url, ts: Date.now() });
      pool.query(`UPDATE wa_chats SET profile_pic_url=$1 WHERE id=$2 AND account_phone=$3`, [url, jid, accPhone]).catch(() => {});
    }
    return url || null;
  } catch {
    profilePicCache.set(jid, { url: null, ts: Date.now() }); // cache miss to avoid re-hitting
    return null;
  }
}

// ── MARK CHAT READ / UNREAD ───────────────────────────────────────────────────────────
async function markChatRead(jid) {
  const formattedJid = formatJid(jid);
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('Connected WhatsApp account is not known yet');

  // Always persist read state locally first (survives refresh even if socket fails)
  await markIncomingMessagesReadInDb(formattedJid, accPhone);

  if (!sock || !isConnected) return;

  const aliases = await resolveChatJidAliases(formattedJid);
  for (const chatJid of aliases) {
    let lastMsg = null;
    try {
      const phoneDigits = chatJid.endsWith('@s.whatsapp.net') ? chatJid.split('@')[0] : null;
      const row = await pool.query(`
        SELECT id, from_me, sender, timestamp, chat_id FROM wa_messages
        WHERE account_phone=$1 AND from_me=false
          AND (
            chat_id=$2
            OR chat_id LIKE split_part($2, '@', 1) || ':%@' || split_part($2, '@', 2)
            OR ($3::text IS NOT NULL AND chat_id IN (
              SELECT wc.jid FROM wa_contacts wc
              WHERE wc.account_phone = $1
                AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') = $3
                AND wc.jid LIKE '%@lid'
            ))
          )
        ORDER BY timestamp DESC LIMIT 1`,
        [accPhone, chatJid, phoneDigits]
      );
      if (row.rows[0]) {
        const r = row.rows[0];
        const remote = formatJid(r.chat_id || chatJid);
        lastMsg = {
          key: {
            remoteJid: remote,
            fromMe: false,
            id: r.id,
            ...(r.sender ? { participant: r.sender } : {}),
          },
          messageTimestamp: Math.floor(new Date(r.timestamp).getTime() / 1000),
        };
      }
    } catch (_) { }
    if (lastMsg) {
      await sock.chatModify({ markRead: true, lastMessages: [lastMsg] }, chatJid).catch((err) => {
        console.warn(`[WA-UNREAD] chatModify markRead failed for ${chatJid}:`, err.message);
      });
    }
  }
}

async function markChatUnread(jid) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const accPhone = phoneNumber;
  let lastMsg = null;
  if (accPhone) {
    try {
      const row = await pool.query(
        `SELECT id, from_me, sender, timestamp FROM wa_messages
         WHERE chat_id=$1 AND account_phone=$2
         ORDER BY timestamp DESC LIMIT 1`,
        [jid, accPhone]
      );
      if (row.rows[0]) {
        const r = row.rows[0];
        lastMsg = { key: { remoteJid: jid, fromMe: r.from_me, id: r.id, ...(r.sender ? { participant: r.sender } : {}) }, messageTimestamp: Math.floor(new Date(r.timestamp).getTime() / 1000) };
      }
    } catch (_) {}
  }
  if (lastMsg) {
    await sock.chatModify({ markRead: false, lastMessages: [lastMsg] }, jid).catch(() => {});
  }
  if (accPhone) {
    await pool.query(`UPDATE wa_chats SET unread=GREATEST(unread,1) WHERE id=$1 AND account_phone=$2`, [jid, accPhone]).catch(() => {});
    emit('wa:chat_unread_update', { jid, unread: 1 });
  }
}

// ── LABELS ───────────────────────────────────────────────────────────────────────────
async function addChatLabel(jid, labelId) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  await sock.addChatLabel(jid, labelId);
}

async function removeChatLabel(jid, labelId) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  await sock.removeChatLabel(jid, labelId);
}

// ── DELETE MESSAGE ─────────────────────────────────────────────────────────────
async function deleteWaMessage(chatJid, msgId, forEveryone = false) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('Connected WhatsApp account is not known yet');
  const formattedJid = formatJid(chatJid);

  let actualChatJid = formattedJid;
  let fromMe = false;
  let sender = null;
  let msgTimestamp = Date.now();
  try {
    const row = await pool.query(
      `SELECT chat_id, from_me, sender, timestamp FROM wa_messages WHERE id=$1 AND account_phone=$2 LIMIT 1`,
      [msgId, accPhone]
    );
    if (row.rows[0]) {
      actualChatJid = row.rows[0].chat_id;
      fromMe = !!row.rows[0].from_me;
      sender = row.rows[0].sender;
      if (row.rows[0].timestamp) {
        msgTimestamp = new Date(row.rows[0].timestamp).getTime();
      }
    }
  } catch (_) {}

  // Map phone JID back to LID JID for socket operation if a mapping exists
  let socketJid = actualChatJid;
  if (actualChatJid.endsWith('@s.whatsapp.net')) {
    const lidMatch = Object.keys(contactsStore).find(
      k => contactsStore[k] && contactsStore[k].phoneJid === actualChatJid
    );
    if (lidMatch) {
      console.log(`[WA] Mapping delete target JID ${actualChatJid} back to LID ${lidMatch} for socket`);
      socketJid = lidMatch;
    }
  }

  let participant = undefined;
  if (socketJid.endsWith('@g.us') && !fromMe && sender) {
    participant = sender;
  }

  const msgKey = {
    id: msgId,
    remoteJid: socketJid,
    fromMe,
    ...(participant ? { participant } : {})
  };

  if (forEveryone) {
    await sock.sendMessage(socketJid, {
      delete: msgKey
    });
  } else {
    // Sync "Delete for me" back to WhatsApp server so it deletes on phone
    try {
      await sock.chatModify({
        deleteForMe: {
          deleteMedia: true,
          key: msgKey,
          timestamp: Math.floor(msgTimestamp / 1000)
        }
      }, socketJid);
    } catch (e) {
      console.warn('[WA] chatModify deleteForMe failed:', e.message);
      try {
        await sock.chatModify({
          deleteForMe: {
            deleteMedia: true,
            key: msgKey,
            timestamp: msgTimestamp
          }
        }, socketJid);
      } catch (_) {}
    }
  }

  // Always remove from local DB using the database format (actualChatJid)
  await pool.query(
    `DELETE FROM wa_messages WHERE id=$1 AND chat_id=$2 AND account_phone=$3`,
    [msgId, actualChatJid, accPhone]
  );
}

// ── EDIT MESSAGE ─────────────────────────────────────────────────────────────
async function editWaMessage(chatJid, msgId, newText) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  const accPhone = phoneNumber;
  if (!accPhone) throw new Error('Connected WhatsApp account is not known yet');
  const formattedJid = formatJid(chatJid);

  let actualChatJid = formattedJid;
  let fromMe = false;
  try {
    const row = await pool.query(
      `SELECT chat_id, from_me FROM wa_messages WHERE id=$1 AND account_phone=$2 LIMIT 1`,
      [msgId, accPhone]
    );
    if (row.rows[0]) {
      actualChatJid = row.rows[0].chat_id;
      fromMe = !!row.rows[0].from_me;
    }
  } catch (_) {}

  if (!fromMe) throw new Error('Cannot edit messages sent by others');

  // Map phone JID back to LID JID for socket operation if a mapping exists
  let socketJid = actualChatJid;
  if (actualChatJid.endsWith('@s.whatsapp.net')) {
    const lidMatch = Object.keys(contactsStore).find(
      k => contactsStore[k] && contactsStore[k].phoneJid === actualChatJid
    );
    if (lidMatch) {
      console.log(`[WA] Mapping edit target JID ${actualChatJid} back to LID ${lidMatch} for socket`);
      socketJid = lidMatch;
    }
  }

  // Send the edit message via Baileys
  await sock.sendMessage(socketJid, {
    text: newText,
    edit: { id: msgId, remoteJid: socketJid, fromMe: true }
  });

  // Update the local DB using the database format (actualChatJid)
  await pool.query(
    `UPDATE wa_messages SET body=$1 WHERE id=$2 AND chat_id=$3 AND account_phone=$4`,
    [newText, msgId, actualChatJid, accPhone]
  );

  // Also update the chat's last message if this was the last message
  try {
    const latestRow = await pool.query(
      `SELECT id FROM wa_messages WHERE chat_id=$1 AND account_phone=$2 ORDER BY timestamp DESC LIMIT 1`,
      [actualChatJid, accPhone]
    );
    if (latestRow.rows[0] && latestRow.rows[0].id === msgId) {
      await pool.query(
        `UPDATE wa_chats SET last_message=$1 WHERE id=$2 AND account_phone=$3`,
        [newText, actualChatJid, accPhone]
      );
      emit('wa:chats_updated', {});
    }
  } catch (err) {
    console.error('[WA] Failed to update chat last_message on edit:', err.message);
  }

  // Emit real-time event to connected clients
  emit('wa:message_edited', {
    id: msgId,
    chatId: actualChatJid,
    body: newText
  });
}

module.exports = { startWA, sendMessage, sendMediaMessage, logout, getStatus, getQR, requestQR, requestPhonePairingCode, setIO, getGroupMetadata, clearGroupMetadataCache: () => { groupMetadataCache.clear(); rawGroupMetadataCache.clear(); }, getGroupSubjectFromCache, refreshCurrentAccountGroupMetadata, resyncDirectoryFromSocket, processLidResolutionBatch, startLidResolutionWorker, stopLidResolutionWorker, downloadMedia, msgCache, importExportedChat, getConnectedPhone, getLiveChats, getLiveMessages, isLidResolutionExhausted, getLidResolutionCooldownMins, resetLidResolution, updateGroupName, flushCachedMediaToDisk, getProfilePicUrl, markChatRead, markChatUnread, markIncomingMessagesReadInDb, reconcileChatUnreadFromMessages, addChatLabel, removeChatLabel, deleteWaMessage, editWaMessage, resetAndResyncGroupContacts, emitEvent: emit };


