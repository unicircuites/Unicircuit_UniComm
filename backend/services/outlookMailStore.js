/**
 * outlook_messages — stores every Sent + Inbox message header in DB.
 *
 * Schema (auto-created on first use):
 *   message_id   TEXT PRIMARY KEY   — Graph message id
 *   folder       TEXT               — 'sent' | 'inbox'
 *   from_addr    TEXT               — lowercased sender address
 *   to_addrs     TEXT[]             — lowercased recipient addresses (to + cc + bcc)
 *   sent_at      TIMESTAMPTZ        — sentDateTime or receivedDateTime
 *   subject      TEXT
 *   synced_at    TIMESTAMPTZ
 *
 * Sync strategy: latest 100 messages stored immediately (fast first response),
 * then remaining pages fetched in background automatically.
 */
const fetch  = require('node-fetch');
const graph  = require('./msGraph');
const pool   = require('../db/pool');

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Track background sync state
const syncState = { running: false, progress: '', done: false, error: null, startedAt: null };

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlook_messages (
      message_id  TEXT        PRIMARY KEY,
      folder      TEXT        NOT NULL,
      from_addr   TEXT        NOT NULL DEFAULT '',
      to_addrs    TEXT[]      NOT NULL DEFAULT '{}',
      sent_at     TIMESTAMPTZ,
      subject     TEXT,
      synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outlook_messages_from ON outlook_messages (from_addr)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outlook_messages_to   ON outlook_messages USING GIN (to_addrs)`);
}

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

function extractAddresses(m) {
  const lists = [m.toRecipients, m.ccRecipients, m.bccRecipients].filter(Boolean);
  const out = [];
  for (const arr of lists) {
    for (const t of (arr || [])) {
      const a = norm(t?.emailAddress?.address);
      if (a) out.push(a);
    }
  }
  return out;
}

async function upsertMessages(messages, folder) {
  for (const m of messages) {
    if (!m.id) continue;
    const fromAddr = norm(m.from?.emailAddress?.address || m.sender?.emailAddress?.address || '');
    const toAddrs  = extractAddresses(m);
    const sentAt   = m.sentDateTime || m.receivedDateTime || null;
    await pool.query(
      `INSERT INTO outlook_messages (message_id, folder, from_addr, to_addrs, sent_at, subject, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (message_id) DO UPDATE SET
         folder=EXCLUDED.folder, from_addr=EXCLUDED.from_addr,
         to_addrs=EXCLUDED.to_addrs, sent_at=EXCLUDED.sent_at,
         subject=EXCLUDED.subject, synced_at=NOW()`,
      [m.id, folder, fromAddr, toAddrs, sentAt, (m.subject || '').slice(0, 500)]
    );
  }
}

/**
 * Fetch one page (100 msgs) from a folder — latest first.
 * Returns { messages, nextLink }
 */
async function fetchPage(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Graph ${res.status}`);
  }
  const data = await res.json();
  return { messages: data.value || [], nextLink: data['@odata.nextLink'] || null };
}

function folderUrl(folderSegment, orderField, afterDate) {
  const sel = encodeURIComponent('id,subject,sentDateTime,receivedDateTime,from,sender,toRecipients,ccRecipients,bccRecipients');
  const order = orderField === 'sent' ? 'sentDateTime desc' : 'receivedDateTime desc';
  let url = `${GRAPH}/${folderSegment}/messages?$top=100&$select=${sel}&$orderby=${encodeURIComponent(order)}`;
  // Incremental: only fetch messages after last sync date
  if (afterDate) {
    const dateField = orderField === 'sent' ? 'sentDateTime' : 'receivedDateTime';
    url += `&$filter=${encodeURIComponent(`${dateField} gt ${afterDate}`)}`;
  }
  return url;
}

/**
 * Get the latest sent_at date we have in DB for a folder — used for incremental sync.
 */
async function getLastStoredDate(folder) {
  try {
    const r = await pool.query(
      `SELECT MAX(sent_at) AS t FROM outlook_messages WHERE folder = $1`, [folder]
    );
    return r.rows[0]?.t ? new Date(r.rows[0].t).toISOString() : null;
  } catch (_) { return null; }
}

/**
 * Quick sync: fetch first page of new messages only (incremental after first run).
 * First run: fetches latest 100. Subsequent runs: only fetches messages newer than last stored.
 * Background sync continues for any remaining pages.
 */
async function quickSync(msEmail) {
  await ensureTable();
  const token = await graph.getAccessToken(msEmail);
  if (!token) throw new Error('NOT_AUTHENTICATED');

  // Incremental: only fetch messages newer than what we already have
  const lastSent  = await getLastStoredDate('sent');
  const lastInbox = await getLastStoredDate('inbox');

  const sentFirst  = await fetchPage(folderUrl('me/mailFolders/sentitems', 'sent',  lastSent),  token);
  const inboxFirst = await fetchPage(folderUrl('me/mailFolders/inbox',     'inbox', lastInbox), token);

  await upsertMessages(sentFirst.messages,  'sent');
  await upsertMessages(inboxFirst.messages, 'inbox');

  // Rebuild stats from what we have so far
  await rebuildStatsFromMessages(msEmail);

  const firstBatch = sentFirst.messages.length + inboxFirst.messages.length;
  const isIncremental = !!(lastSent || lastInbox);

  // Kick off background sync for remaining pages (don't await)
  if (sentFirst.nextLink || inboxFirst.nextLink) {
    backgroundSync(msEmail, token, sentFirst.nextLink, inboxFirst.nextLink, firstBatch).catch(e => {
      syncState.error = e.message;
      syncState.running = false;
    });
  } else {
    syncState.done     = true;
    syncState.running  = false;
    syncState.progress = `${firstBatch} new messages — fully synced`;
  }

  return {
    first_batch:    firstBatch,
    has_more:       !!(sentFirst.nextLink || inboxFirst.nextLink),
    incremental:    isIncremental,
    synced_at:      new Date().toISOString(),
  };
}

/**
 * Background: fetch remaining pages after quickSync, rebuild stats once at end.
 */
async function backgroundSync(msEmail, token, sentNextLink, inboxNextLink, alreadyStored) {
  syncState.running = true;
  syncState.done    = false;
  syncState.error   = null;
  syncState.startedAt = new Date().toISOString();
  let total = alreadyStored;

  // Continue sent pages
  let sentUrl = sentNextLink;
  while (sentUrl) {
    const page = await fetchPage(sentUrl, token);
    await upsertMessages(page.messages, 'sent');
    total += page.messages.length;
    syncState.progress = `${total} messages stored…`;
    sentUrl = page.nextLink;
  }

  // Continue inbox pages
  let inboxUrl = inboxNextLink;
  while (inboxUrl) {
    const page = await fetchPage(inboxUrl, token);
    await upsertMessages(page.messages, 'inbox');
    total += page.messages.length;
    syncState.progress = `${total} messages stored…`;
    inboxUrl = page.nextLink;
  }

  // Rebuild stats once at the end — all messages are now in DB
  syncState.progress = `${total} messages stored — rebuilding stats…`;
  await rebuildStatsFromMessages(msEmail);

  syncState.running  = false;
  syncState.done     = true;
  syncState.progress = `${total} messages — fully synced`;
  console.log(`[OutlookMailStore] Background sync complete: ${total} messages`);
}

/**
 * Rebuild outlook_mail_stats from outlook_messages (pure SQL, fast).
 */
async function rebuildStatsFromMessages(msEmail) {
  const myAddr = norm(msEmail);
  if (!myAddr) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlook_mail_stats (
      email           TEXT PRIMARY KEY,
      sent_to_them    INT  NOT NULL DEFAULT 0,
      received_from   INT  NOT NULL DEFAULT 0,
      last_email_at   TIMESTAMPTZ,
      synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO outlook_mail_stats (email, sent_to_them, received_from, last_email_at, synced_at)
    SELECT
      addr,
      COALESCE(s.cnt, 0)                 AS sent_to_them,
      COALESCE(r.cnt, 0)                 AS received_from,
      GREATEST(s.last_at, r.last_at)     AS last_email_at,
      NOW()                              AS synced_at
    FROM (
      SELECT DISTINCT addr FROM (
        SELECT unnest(to_addrs) AS addr FROM outlook_messages WHERE folder = 'sent'
        UNION
        SELECT from_addr AS addr FROM outlook_messages WHERE folder = 'inbox'
      ) x
      WHERE addr <> '' AND addr <> $1
    ) all_addrs
    LEFT JOIN (
      SELECT unnest(to_addrs) AS addr, COUNT(*)::int AS cnt, MAX(sent_at) AS last_at
      FROM outlook_messages WHERE folder = 'sent' GROUP BY 1
    ) s USING (addr)
    LEFT JOIN (
      SELECT from_addr AS addr, COUNT(*)::int AS cnt, MAX(sent_at) AS last_at
      FROM outlook_messages WHERE folder = 'inbox' GROUP BY 1
    ) r USING (addr)
    ON CONFLICT (email) DO UPDATE SET
      sent_to_them  = EXCLUDED.sent_to_them,
      received_from = EXCLUDED.received_from,
      last_email_at = EXCLUDED.last_email_at,
      synced_at     = EXCLUDED.synced_at
  `, [myAddr]);
}

// fullSync kept for backward compat — now just calls quickSync
async function fullSync(msEmail) {
  const result = await quickSync(msEmail);
  return {
    sent:  { fetched: result.first_batch, upserted: result.first_batch },
    inbox: { fetched: 0, upserted: 0 },
    synced_at: result.synced_at,
    has_more: result.has_more,
  };
}

async function getStatsForEmail(email) {
  if (!email) return null;
  try {
    await ensureTable();
    const n = norm(email);
    const r = await pool.query(
      `SELECT sent_to_them, received_from, last_email_at, synced_at
       FROM outlook_mail_stats WHERE email = $1`, [n]
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function lastSyncedAt() {
  try {
    await ensureTable();
    const r = await pool.query(`SELECT MAX(synced_at) AS t FROM outlook_messages`);
    return r.rows[0]?.t ? new Date(r.rows[0].t).toISOString() : null;
  } catch (_) { return null; }
}

async function messageCount() {
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM outlook_messages`);
    return r.rows[0]?.n || 0;
  } catch (_) { return 0; }
}

function getSyncState() { return { ...syncState }; }

module.exports = { fullSync, quickSync, getStatsForEmail, lastSyncedAt, messageCount, ensureTable, norm, getSyncState };
