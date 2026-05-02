/**
 * Outlook (Graph) mail stats for one external address — pure API + rules (no AI).
 * Merges: Sent/Inbox search, recent folder pages, and mailbox-wide $search.
 */
const fetch = require('node-fetch');
const graph = require('./msGraph');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MS_EMAIL = process.env.MS_USER_EMAIL;

/** Pages × 50 messages per folder (sent + inbox) for directory + fallback stats */
const MAIL_SCAN_PAGES = 28;

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

function allRecipients(m) {
  const lists = [m.toRecipients, m.ccRecipients, m.bccRecipients].filter(Boolean);
  const out = [];
  for (const arr of lists) {
    for (const t of arr) {
      const a = norm(t.emailAddress?.address);
      if (a) out.push(a);
    }
  }
  return out;
}

function isSentToThem(m, target) {
  return allRecipients(m).includes(target);
}

/** SMTP of the party who authored the message (Graph often fills only one of from / sender). */
function messageAuthorAddress(m) {
  const a = m?.from?.emailAddress?.address || m?.sender?.emailAddress?.address;
  return a ? String(a).trim() : '';
}

function isReceivedFromThem(m, target) {
  return norm(messageAuthorAddress(m)) === target;
}

/**
 * True if this message was authored by our mailbox (outbound). Use From only — some inbound
 * messages carry our address on Sender (transport) while From is external; counting Sender
 * made us treat real inbound as outbound and skip received counts.
 */
function isFromMyMailbox(m, myMailbox) {
  if (!myMailbox) return false;
  const from = norm(m.from?.emailAddress?.address);
  return !!from && from === myMailbox;
}

function msgSizeBytes(m) {
  const n = Number(m?.size);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function fetchFolderMessagesWithSearch(folderSegment, searchKql, token) {
  const sel = encodeURIComponent(
    'id,size,sentDateTime,receivedDateTime,from,sender,toRecipients,ccRecipients,bccRecipients'
  );
  const q = encodeURIComponent(searchKql);
  let url = `${GRAPH}/${folderSegment}/messages?$top=100&$select=${sel}&$search=${q}`;
  const messages = [];
  for (let p = 0; p < 10 && url; p++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error?.message || `${res.status}`;
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    messages.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return messages;
}

async function fetchFolderRecent(folderSegment, token, orderField, maxPages = 4) {
  const sel = encodeURIComponent(
    'id,size,sentDateTime,receivedDateTime,from,sender,toRecipients,ccRecipients,bccRecipients'
  );
  const order = orderField === 'sent' ? 'sentDateTime desc' : 'receivedDateTime desc';
  let url = `${GRAPH}/${folderSegment}/messages?$top=50&$select=${sel}&$orderby=${encodeURIComponent(order)}`;
  const messages = [];
  for (let p = 0; p < maxPages && url; p++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const data = await res.json();
    messages.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return messages;
}

/** Whole mailbox search (any folder) — needs ConsistencyLevel: eventual */
async function fetchGlobalMessagesSearch(addr, token) {
  const sel = encodeURIComponent(
    'id,size,sentDateTime,receivedDateTime,from,sender,toRecipients,ccRecipients,bccRecipients'
  );
  const safe = addr.replace(/"/g, ' ');
  const q = encodeURIComponent(`"${safe}"`);
  let url = `${GRAPH}/me/messages?$top=100&$select=${sel}&$search=${q}`;
  const messages = [];
  for (let p = 0; p < 10 && url; p++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
    });
    if (!res.ok) break;
    const data = await res.json();
    messages.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return messages;
}

function computeStats(allById, sentFolderIds, target, myMailbox) {
  let last = null;
  let sentToThem = 0;
  let receivedFromThem = 0;
  let mailBytesSent = 0;
  let mailBytesReceived = 0;

  for (const m of allById.values()) {
    const sz = msgSizeBytes(m);
    if (isReceivedFromThem(m, target)) {
      receivedFromThem++;
      mailBytesReceived += sz;
      const t = m.receivedDateTime || m.sentDateTime;
      if (t && (!last || t > last)) last = t;
      continue;
    }
    if (!isSentToThem(m, target)) continue;
    if (sentFolderIds.has(m.id) || isFromMyMailbox(m, myMailbox)) {
      sentToThem++;
      mailBytesSent += sz;
      const t = m.sentDateTime || m.receivedDateTime;
      if (t && (!last || t > last)) last = t;
    }
  }

  return { lastEmailAt: last, sentToThem, receivedFromThem, mailBytesSent, mailBytesReceived };
}

/**
 * @param {string} contactEmail
 * @returns {Promise<{ lastEmailAt: string|null, sentToThem: number, receivedFromThem: number, mailBytesSent: number, mailBytesReceived: number }>}
 */
async function getStatsForEmail(contactEmail) {
  const target = norm(contactEmail);
  if (!target) {
    return {
      lastEmailAt: null,
      sentToThem: 0,
      receivedFromThem: 0,
      mailBytesSent: 0,
      mailBytesReceived: 0,
    };
  }
  const myMailbox = norm(MS_EMAIL);
  if (!myMailbox) {
    throw new Error('MS_USER_EMAIL is not configured');
  }

  const token = await graph.getAccessToken(MS_EMAIL);
  if (!token) throw new Error('NOT_AUTHENTICATED');

  const addr = contactEmail.trim();
  const sentFolderIds = new Set();
  const allById = new Map();

  function absorb(msgs) {
    for (const m of msgs) {
      if (m && m.id) allById.set(m.id, m);
    }
  }

  let sentMsgs = [];
  let inboxMsgs = [];

  try {
    sentMsgs = await fetchFolderMessagesWithSearch('me/mailFolders/sentitems', `to:${addr}`, token);
  } catch (e) {
    try {
      sentMsgs = await fetchFolderMessagesWithSearch('me/mailFolders/sentitems', addr, token);
    } catch (_) {
      sentMsgs = [];
    }
  }
  try {
    inboxMsgs = await fetchFolderMessagesWithSearch('me/mailFolders/inbox', `from:${addr}`, token);
  } catch (e) {
    try {
      inboxMsgs = await fetchFolderMessagesWithSearch('me/mailFolders/inbox', addr, token);
    } catch (_) {
      inboxMsgs = [];
    }
  }

  sentMsgs.forEach((m) => {
    if (m.id) sentFolderIds.add(m.id);
  });
  absorb(sentMsgs);
  absorb(inboxMsgs);

  let stats = computeStats(allById, sentFolderIds, target, myMailbox);

  if (stats.sentToThem === 0 && stats.receivedFromThem === 0) {
    const sentRecent = await fetchFolderRecent('me/mailFolders/sentitems', token, 'sent', MAIL_SCAN_PAGES);
    const inboxRecent = await fetchFolderRecent('me/mailFolders/inbox', token, 'received', MAIL_SCAN_PAGES);
    sentRecent.forEach((m) => {
      if (m.id) sentFolderIds.add(m.id);
    });
    absorb(sentRecent);
    absorb(inboxRecent);
    stats = computeStats(allById, sentFolderIds, target, myMailbox);
  }

  if (stats.sentToThem === 0 && stats.receivedFromThem === 0) {
    const globalMsgs = await fetchGlobalMessagesSearch(addr, token);
    globalMsgs.forEach((m) => {
      if (m.id) allById.set(m.id, m);
    });
    stats = computeStats(allById, sentFolderIds, target, myMailbox);
  }

  if (stats.sentToThem === 0 && stats.receivedFromThem === 0) {
    console.warn(
      '[Outlook mail stats] No messages matched',
      addr,
      'for mailbox',
      MS_EMAIL,
      '| CRM email must match headers; mail must exist in this M365 account.'
    );
  }

  return stats;
}

/**
 * One pass over Sent + Inbox (recent pages) to build per-address mail counts + last activity.
 * Catches people you only ever emailed (not in People folder) and aligns stats with the same scan.
 *
 * @returns {Map<string, { lastEmailAt: string|null, sentToThem: number, receivedFromThem: number, primaryEmail: string }>}
 *   Keys are norm(email)
 */
async function buildDirectoryStatsMap(msEmail, maxPages = MAIL_SCAN_PAGES) {
  const myMailbox = norm(msEmail || MS_EMAIL);
  if (!myMailbox) {
    throw new Error('MS_USER_EMAIL is not configured');
  }
  const token = await graph.getAccessToken(msEmail);
  if (!token) throw new Error('NOT_AUTHENTICATED');

  const sentFolderIds = new Set();
  const sentRecent = await fetchFolderRecent('me/mailFolders/sentitems', token, 'sent', maxPages);
  const inboxRecent = await fetchFolderRecent('me/mailFolders/inbox', token, 'received', maxPages);
  const byId = new Map();
  for (const m of sentRecent) {
    if (m && m.id) {
      sentFolderIds.add(m.id);
      byId.set(m.id, m);
    }
  }
  for (const m of inboxRecent) {
    if (m && m.id && !byId.has(m.id)) byId.set(m.id, m);
  }

  const statsMap = new Map();
  function bump(emailRaw, field, ts) {
    const k = norm(emailRaw);
    if (!k || k === myMailbox) return;
    let o = statsMap.get(k);
    if (!o) {
      o = { lastEmailAt: null, sentToThem: 0, receivedFromThem: 0, primaryEmail: String(emailRaw || '').trim() || k };
    }
    if (field === 'sent') o.sentToThem += 1;
    if (field === 'recv') o.receivedFromThem += 1;
    if (ts && (!o.lastEmailAt || ts > o.lastEmailAt)) {
      o.lastEmailAt = ts;
      if (emailRaw && norm(emailRaw) === k) o.primaryEmail = String(emailRaw).trim();
    }
    statsMap.set(k, o);
  }

  for (const m of byId.values()) {
    const ts = m.sentDateTime || m.receivedDateTime;
    if (!ts) continue;
    const inSent = sentFolderIds.has(m.id);
    const fromMe = isFromMyMailbox(m, myMailbox);
    if (fromMe || inSent) {
      for (const a of allRecipients(m)) {
        bump(a, 'sent', ts);
      }
    } else {
      const fromAddr = messageAuthorAddress(m);
      if (fromAddr) bump(fromAddr, 'recv', ts);
    }
  }

  return statsMap;
}

module.exports = { getStatsForEmail, buildDirectoryStatsMap, MAIL_SCAN_PAGES, norm };
