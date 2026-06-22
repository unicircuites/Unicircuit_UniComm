/**
 * Outlook / Microsoft Graph Routes
 * GET  /api/outlook/status          — check if authenticated
 * GET  /api/outlook/auth            — get OAuth2 login URL
 * GET  /auth/callback               — OAuth2 callback (no JWT needed)
 * GET  /api/outlook/inbox           — list inbox messages
 * GET  /api/outlook/message/:id     — get full message body (+ uniqueBody, attachments)
 * GET  /api/outlook/message/:id/attachments — list attachment metadata
 * GET  /api/outlook/thread          — messages in a conversation (?conversationId=)
 * GET  /api/outlook/message/:mid/attachment/:aid/raw — inline attachment bytes (auth)
 * POST /api/outlook/send            — send email
 * POST /api/outlook/reply/:id       — reply to a message
 * PATCH /api/outlook/message/:id    — mark read / move / categorize
 * GET  /api/outlook/sent            — sent items
 * GET  /api/outlook/folders         — list mail folders
 * GET  /api/outlook/contacts           — People folder (paginated) + Sent/Inbox-derived addresses & mailStats
 * GET  /api/outlook/directory-activity — mail stats + broadcast count by email (for People directory detail)
 * POST /api/outlook/contacts           — create a new Outlook contact (displayName + email required)
 * POST /api/outlook/contacts/import    — import all into CRM contacts (skip duplicate email / same Graph id)
 */
const express  = require('express');
const fetch    = require('node-fetch');
const fs       = require('fs');
const path     = require('path');
const graph    = require('../services/msGraph');
const pool     = require('../db/pool');
const mailStats  = require('../services/outlookContactMailStats');
const statsCache = require('../services/outlookStatsCache');
const mailStore  = require('../services/outlookMailStore');
const { authenticate } = require('../middleware/auth');
const activityLog = require('../services/activityLog');

const router = express.Router();
const MS_EMAIL = process.env.MS_USER_EMAIL;

function resolvePicoClawModel() {
  const configured = String(process.env.AI_API_MODEL || '').trim();
  if (!configured || /^gemma2-9b-it$/i.test(configured)) return 'llama-3.1-8b-instant';
  return configured;
}

// Helper function to store messages in database
async function storeMessagesInDB(messages, folder) {
  await mailStore.ensureTable();

  // Ensure outlook_emails_cache table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlook_emails_cache (
      id                TEXT PRIMARY KEY,
      conversation_id   TEXT,
      subject           TEXT,
      from_address      TEXT,
      from_name         TEXT,
      to_recipients     JSONB,
      cc_recipients     JSONB,
      received_datetime TIMESTAMPTZ,
      sent_datetime     TIMESTAMPTZ,
      is_read           BOOLEAN DEFAULT FALSE,
      body_preview      TEXT,
      has_attachments   BOOLEAN DEFAULT FALSE,
      importance        TEXT,
      folder            TEXT DEFAULT 'inbox',
      category          TEXT DEFAULT 'GENERAL',
      synced_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  for (const msg of messages) {
    try {
      await pool.query(`
        INSERT INTO outlook_emails_cache (
          id, conversation_id, subject, from_address, from_name,
          to_recipients, cc_recipients, received_datetime, sent_datetime,
          is_read, body_preview, has_attachments, importance, folder, synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (id) DO UPDATE SET
          conversation_id = EXCLUDED.conversation_id,
          subject = EXCLUDED.subject,
          from_address = EXCLUDED.from_address,
          from_name = EXCLUDED.from_name,
          to_recipients = EXCLUDED.to_recipients,
          cc_recipients = EXCLUDED.cc_recipients,
          received_datetime = EXCLUDED.received_datetime,
          sent_datetime = EXCLUDED.sent_datetime,
          is_read = EXCLUDED.is_read,
          body_preview = EXCLUDED.body_preview,
          has_attachments = EXCLUDED.has_attachments,
          importance = EXCLUDED.importance,
          folder = EXCLUDED.folder,
          synced_at = NOW()
      `, [
        msg.id,
        msg.conversationId || null,
        msg.subject || '',
        msg.from?.emailAddress?.address || '',
        msg.from?.emailAddress?.name || '',
        JSON.stringify(msg.toRecipients || []),
        JSON.stringify(msg.ccRecipients || []),
        msg.receivedDateTime || null,
        msg.sentDateTime || null,
        msg.isRead || false,
        msg.bodyPreview || '',
        msg.hasAttachments || false,
        msg.importance || 'normal',
        folder
      ]);
    } catch (err) {
      console.warn(`[Outlook] Failed to store message ${msg.id}:`, err.message);
    }
  }
}

async function getCachedFolderStats() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlook_emails_cache (
      id                TEXT PRIMARY KEY,
      conversation_id   TEXT,
      subject           TEXT,
      from_address      TEXT,
      from_name         TEXT,
      to_recipients     JSONB,
      cc_recipients     JSONB,
      received_datetime TIMESTAMPTZ,
      sent_datetime     TIMESTAMPTZ,
      is_read           BOOLEAN DEFAULT FALSE,
      body_preview      TEXT,
      has_attachments   BOOLEAN DEFAULT FALSE,
      importance        TEXT,
      folder            TEXT DEFAULT 'inbox',
      category          TEXT DEFAULT 'GENERAL',
      synced_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const result = await pool.query(`
    SELECT
      COALESCE(NULLIF(folder, ''), 'inbox') AS folder,
      COUNT(*)::int AS total_count,
      COALESCE(SUM(CASE WHEN is_read IS FALSE THEN 1 ELSE 0 END), 0)::int AS unread_count
    FROM outlook_emails_cache
    GROUP BY COALESCE(NULLIF(folder, ''), 'inbox')
  `);

  const labels = {
    inbox: 'Inbox',
    sent: 'Sent Items',
    drafts: 'Drafts',
    deleted: 'Deleted Items',
    junk: 'Junk Email',
    archive: 'Archive',
    notes: 'Notes',
  };

  return result.rows.map((row) => {
    const key = String(row.folder || 'inbox').toLowerCase();
    return {
      id: `cached-${key}`,
      displayName: labels[key] || row.folder,
      totalItemCount: Number(row.total_count || 0),
      unreadItemCount: Number(row.unread_count || 0),
      childFolderCount: 0,
      source: 'cache',
    };
  });
}

const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || `http://localhost:${process.env.PORT || 8088}`).replace(/\/$/, '');
const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const MESSAGE_SIZE_PROPS = ['Integer 0x0E08', 'Long 0x0E08'];
const STORAGE_SCAN_CACHE_MS = 5 * 60 * 1000;
let storageScanCache = null;
const STORAGE_SNAPSHOT_PATH = path.join(__dirname, '..', 'config', 'outlookStorageSnapshot.json');
let lastContactsTrace = {};
const OUTLOOK_CONTACTS_CONSOLE_TRACE = process.env.OUTLOOK_CONTACTS_CONSOLE_TRACE === '1';

function contactsTraceLog(...args) {
  if (OUTLOOK_CONTACTS_CONSOLE_TRACE) console.log(...args);
}

function contactsTraceWarn(...args) {
  if (OUTLOOK_CONTACTS_CONSOLE_TRACE) console.warn(...args);
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function summarizeGraphToken(token) {
  const claims = decodeJwtPayload(token) || {};
  const scopes = String(claims.scp || '').split(/\s+/).filter(Boolean);
  const roles = Array.isArray(claims.roles) ? claims.roles : [];
  return {
    tokenType: scopes.length ? 'delegated' : (roles.length ? 'application' : 'unknown'),
    permissionSignal: scopes.length ? 'scp' : (roles.length ? 'roles' : 'none'),
    scopes,
    roles,
    hasContactsRead: scopes.includes('Contacts.Read') || roles.includes('Contacts.Read'),
    hasContactsReadWrite: scopes.includes('Contacts.ReadWrite') || roles.includes('Contacts.ReadWrite'),
    hasPeopleRead: scopes.includes('People.Read') || roles.includes('People.Read'),
    audience: claims.aud || null,
    tenantId: claims.tid || null,
    appId: claims.appid || claims.azp || null,
    user: claims.preferred_username || claims.upn || null,
    expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
  };
}

function safeHeaderValue(value) {
  return Buffer.from(JSON.stringify(value || {})).toString('base64url');
}

function contactsTraceHeaderSummary(trace) {
  const contacts = trace && trace.contacts || {};
  const people = trace && trace.people || {};
  return {
    requestedAt: trace && trace.requestedAt,
    mailbox: trace && trace.mailbox,
    contactsToken: contacts.token,
    contactsSelect: contacts.select,
    contactsTotalFetched: contacts.totalFetched,
    contactsWithPhone: contacts.withPhone,
    contactsMeSupplementalAdded: contacts.meSupplementalAdded,
    contactsMeSupplementalSkipped: contacts.meSupplementalSkipped,
    contactFolders: Array.isArray(contacts.folders) ? contacts.folders.map(f => f.name) : [],
    contactsEndpointCount: Array.isArray(contacts.endpoints) ? contacts.endpoints.length : 0,
    peopleToken: people.token || null,
    peopleAuthMode: people.authMode || null,
    peopleRequiredApplicationPermission: people.requiredApplicationPermission || null,
    peopleRequestedScopes: people.requestedScopes || null,
    peopleSelect: people.select || null,
    peopleTotalFetched: people.totalFetched,
    peopleWithPhone: people.withPhone,
    peoplePhoneMapSize: people.phoneMapSize,
    peopleMergedIntoContacts: people.mergedIntoContacts,
    peopleError: people.error || null,
    orgContactsToken: (trace && trace.orgContacts || {}).token || null,
    orgContactsSelect: (trace && trace.orgContacts || {}).select || null,
    orgContactsRequiredPermission: (trace && trace.orgContacts || {}).requiredPermission || 'OrgContact.Read.All',
    orgContactsTotalFetched: (trace && trace.orgContacts || {}).totalFetched,
    orgContactsWithPhone: (trace && trace.orgContacts || {}).withPhone,
    orgContactsError: (trace && trace.orgContacts || {}).error || null,
    directoryUsersTotalFetched: (trace && trace.directoryUsers || {}).totalFetched,
    directoryUsersError: (trace && trace.directoryUsers || {}).error || null,
  };
}

function contactPrimaryEmail(contact) {
  return ((contact && contact.emailAddresses || []).map(e => e && e.address).filter(Boolean)[0] || '').trim();
}

function contactPhoneSummary(contact) {
  const businessPhones = Array.isArray(contact && contact.businessPhones) ? contact.businessPhones.filter(Boolean) : [];
  const homePhones = Array.isArray(contact && contact.homePhones) ? contact.homePhones.filter(Boolean) : [];
  return {
    mobilePhone: (contact && contact.mobilePhone) || null,
    businessPhones,
    homePhones,
    resolvedPhone: (contact && contact.resolvedPhone) || null,
    resolvedPhoneSource: (contact && contact.resolvedPhoneSource) || null,
    hasAnyPhone: !!((contact && contact.mobilePhone) || businessPhones.length || homePhones.length || (contact && contact.resolvedPhone)),
  };
}

function traceContactSample(label, contacts, limit = 8) {
  if (!OUTLOOK_CONTACTS_CONSOLE_TRACE) return;
  const list = Array.isArray(contacts) ? contacts : [];
  const withEmail = list.filter(c => contactPrimaryEmail(c));
  const withPhone = list.filter(c => contactPhoneSummary(c).hasAnyPhone);
  const bySource = list.reduce((acc, c) => {
    const key = c && c.source || 'raw-graph';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log(`[Outlook Contacts][TRACE][${label}] count=${list.length}, withEmail=${withEmail.length}, withPhone=${withPhone.length}, sources=${JSON.stringify(bySource)}`);
  list.slice(0, limit).forEach((c, i) => {
    const phones = contactPhoneSummary(c);
    console.log(`[Outlook Contacts][TRACE][${label}][sample:${i}] source="${c.source || 'raw-graph'}" id="${String(c.id || '').slice(0, 24)}" name="${c.displayName || ''}" email="${contactPrimaryEmail(c)}" phone=${JSON.stringify(phones)}`);
  });
  if (withPhone.length > limit) {
    console.log(`[Outlook Contacts][TRACE][${label}] phone sample truncated: showing ${limit} of ${withPhone.length}`);
  }
}

function tracePermissionDecision(label, tokenSummary, required) {
  if (!OUTLOOK_CONTACTS_CONSOLE_TRACE) return;
  const summary = tokenSummary || {};
  console.log(`[Outlook Contacts][TRACE][${label}] auth tokenType=${summary.tokenType || 'unknown'}, signal=${summary.permissionSignal || 'none'}, user="${summary.user || ''}", tenant="${summary.tenantId || ''}", appId="${summary.appId || ''}", expiresAt="${summary.expiresAt || ''}"`);
  console.log(`[Outlook Contacts][TRACE][${label}] required=${JSON.stringify(required)}, scopes=${JSON.stringify(summary.scopes || [])}, roles=${JSON.stringify(summary.roles || [])}`);
}

function clearStorageScanCache() {
  storageScanCache = null;
}

function normalizeMailRecipientAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const bracketMatch = raw.match(/<([^<>]+)>/);
  const looseMatch = raw.match(/[^\s<>"']+@[^\s<>"']+\.[^\s<>"',;]+/);
  const email = String((bracketMatch && bracketMatch[1]) || (looseMatch && looseMatch[0]) || '').trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : '';
}

function normalizeMailRecipients(value) {
  const seen = new Set();
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap(item => String(item || '').split(/[,;]+/))
    .map(normalizeMailRecipientAddress)
    .filter(Boolean)
    .filter(email => {
      const key = email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildGraphFileAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.map((att, index) => {
    // Strip any accidental data-URL prefix, then remove ALL whitespace (spaces, \r, \n, \t)
    // that some browsers/encoders may insert into base64 strings
    const rawBytes = String(att && att.contentBytes || '').replace(/^data:[^,]+,/, '');
    const contentBytes = rawBytes.replace(/\s/g, '');
    const name = String(att && att.name || `attachment-${index + 1}`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
    if (!contentBytes || !/^[A-Za-z0-9+/=]+$/.test(contentBytes)) {
      console.warn('[OUTLOOK] Skipping invalid attachment:', name, '| bytes length:', contentBytes.length);
      return null;
    }
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name,
      contentType: String(att.contentType || 'application/octet-stream'),
      contentBytes,
      isInline: !!att.isInline,
      ...(att.contentId ? { contentId: String(att.contentId).replace(/^<|>$/g, '') } : {})
    };
  }).filter(Boolean);
}

function graphAttachmentBytes(att) {
  return Buffer.from(String(att.contentBytes || '').replace(/^data:[^,]+,/, '').replace(/\s/g, ''), 'base64');
}

async function graphFetchRaw(endpoint, options = {}) {
  const token = await graph.getAccessToken(MS_EMAIL);
  if (!token) throw new Error('NOT_AUTHENTICATED');
  const resolved = endpoint.replace(/^\/me(\/|$)/, `/users/${encodeURIComponent(MS_EMAIL)}$1`);
  const response = await fetch(`${GRAPH_ROOT}${resolved}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const graphErr = new Error(err.error?.message || `Graph API error ${response.status}`);
    graphErr.status = response.status;
    graphErr.code = err.error?.code;
    throw graphErr;
  }
  if (response.status === 202 || response.status === 204) return { success: true };
  return response.json().catch(() => ({ success: true }));
}

async function uploadLargeAttachmentToMessage(messageId, att) {
  const bytes = graphAttachmentBytes(att);
  const session = await graphFetchRaw(`/me/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      AttachmentItem: {
        attachmentType: 'file',
        name: att.name,
        size: bytes.length,
        contentType: att.contentType || 'application/octet-stream',
      },
    }),
  });
  if (!session || !session.uploadUrl) throw new Error(`Could not create upload session for ${att.name}`);

  const chunkSize = 327680 * 10; // 3.125 MB, must be a multiple of 320 KiB.
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, bytes.length) - 1;
    const chunk = bytes.subarray(start, end + 1);
    const uploadRes = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      },
      body: chunk,
    });
    if (![200, 201, 202].includes(uploadRes.status)) {
      const txt = await uploadRes.text().catch(() => '');
      throw new Error(`Large attachment upload failed for ${att.name}: ${txt || uploadRes.status}`);
    }
  }
}

async function addAttachmentsToMessage(messageId, attachments) {
  const graphAttachments = buildGraphFileAttachments(attachments);
  const smallLimit = 3 * 1024 * 1024;
  for (const att of graphAttachments) {
    const byteLength = graphAttachmentBytes(att).length;
    if (byteLength > smallLimit) {
      await uploadLargeAttachmentToMessage(messageId, att);
      continue;
    }
    await graph.graphPost(`/me/messages/${encodeURIComponent(messageId)}/attachments`, att, MS_EMAIL);
  }
  return graphAttachments.length;
}

async function sendDraftMessage(message, attachments) {
  const draft = await graph.graphPost('/me/messages', message, MS_EMAIL);
  if (!draft || !draft.id) throw new Error('Could not create Outlook draft for attachments.');
  const count = await addAttachmentsToMessage(draft.id, attachments);
  await graph.graphPost(`/me/messages/${encodeURIComponent(draft.id)}/send`, {}, MS_EMAIL);
  return { draftId: draft.id, attachments: count };
}

function sendOutlookSettingsError(res, err) {
  if (err.message === 'NOT_AUTHENTICATED') {
    return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
  }

  const code = String(err.code || '');
  const message = String(err.message || '');
  if (err.status === 403 || /access is denied|ErrorAccessDenied|Authorization_RequestDenied/i.test(`${code} ${message}`)) {
    return res.status(403).json({
      error: 'Outlook permission denied. Grant Microsoft Graph MailboxSettings.ReadWrite and reconnect Outlook.',
      code: code || 'ACCESS_DENIED',
    });
  }

  return res.status(500).json({ error: err.message });
}

function isGraphAccessDenied(err) {
  const code = String(err && err.code || '');
  const message = String(err && err.message || '');
  return err && (err.status === 403 || /access is denied|ErrorAccessDenied|Authorization_RequestDenied/i.test(`${code} ${message}`));
}

async function graphSettingsFetch(endpoint, options = {}) {
  try {
    if (options.method === 'POST') {
      return await graph.graphPost(endpoint, options.body || {}, MS_EMAIL);
    }
    if (options.method === 'PATCH') {
      return await graph.graphPatch(endpoint, options.body || {}, MS_EMAIL);
    }
    return await graph.graphGet(endpoint, MS_EMAIL);
  } catch (err) {
    if (!isGraphAccessDenied(err)) throw err;
  }

  const token = await graph.getClientCredentialsToken(true);
  if (!token) throw new Error('NOT_AUTHENTICATED');

  const url = `${GRAPH_ROOT}${endpoint.replace(/^\/me(\/|$)/, `/users/${encodeURIComponent(MS_EMAIL)}$1`)}`;
  const fetchOptions = {
    method: options.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (options.body !== undefined) fetchOptions.body = JSON.stringify(options.body);

  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const graphErr = new Error(err.error?.message || `Graph API error ${res.status}`);
    graphErr.status = res.status;
    graphErr.code = err.error?.code;
    throw graphErr;
  }
  if (res.status === 202 || res.status === 204) return { success: true };
  return res.json().catch(() => ({ success: true }));
}

function csvCell(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < String(line || '').length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseMailboxUsageCsv(csv, mailbox) {
  const lines = String(csv || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const headers = csvCell(lines[0]);
  const wanted = String(mailbox || '').trim().toLowerCase();
  let fallback = null;
  for (const line of lines.slice(1)) {
    const values = csvCell(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i]; });
    const parsed = {
      reportRefreshDate: row['Report Refresh Date'] || null,
      reportPeriod: row['Report Period'] || null,
      itemCount: Number(row['Item Count'] || 0),
      storageUsedBytes: Number(row['Storage Used (Byte)'] || 0),
      issueWarningQuotaBytes: Number(row['Issue Warning Quota (Byte)'] || 0),
      prohibitSendQuotaBytes: Number(row['Prohibit Send Quota (Byte)'] || 0),
      prohibitSendReceiveQuotaBytes: Number(row['Prohibit Send/Receive Quota (Byte)'] || 0),
      deletedItemCount: Number(row['Deleted Item Count'] || 0),
      deletedItemSizeBytes: Number(row['Deleted Item Size (Byte)'] || 0),
      deletedItemQuotaBytes: Number(row['Deleted Item Quota (Byte)'] || 0),
      hasArchive: String(row['Has Archive'] || '').toLowerCase() === 'true',
    };
    fallback = fallback || parsed;
    const upn = String(row['User Principal Name'] || '').trim().toLowerCase();
    if (!wanted || upn === wanted) return parsed;
  }
  if (lines.length === 2 && fallback) return fallback;
  throw new Error('Mailbox usage report loaded, but target mailbox row was not visible. Check Microsoft 365 Reports concealed user names setting.');
}

function friendlyMailboxUsageError(err) {
  const raw = String(err && err.message ? err.message : err || '');
  let code = '';
  let message = raw;

  try {
    const parsed = JSON.parse(raw);
    code = parsed.error?.code || parsed.code || '';
    message = parsed.error?.message || parsed.message || raw;
  } catch (_) {}

  if (/S2SUnauthorized|Invalid permission|Reports\.Read\.All|permission|privilege|authorization|access/i.test(`${code} ${message}`)) {
    return {
      code: code || 'REPORTS_PERMISSION_MISSING',
      message: 'Exact storage quota needs Microsoft Graph Reports.Read.All admin consent. Showing folder counts for now.',
    };
  }

  return {
    code: code || 'REPORT_UNAVAILABLE',
    message: message || 'Storage usage report is unavailable. Showing folder counts for now.',
  };
}

async function downloadMailboxUsageReport(token) {
  if (!token) throw new Error('NOT_AUTHENTICATED');

  const reportUrl = `${GRAPH_ROOT}/reports/getMailboxUsageDetail(period='D7')`;
  const reportRes = await fetch(reportUrl, {
    redirect: 'manual',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (reportRes.status === 302) {
    const location = reportRes.headers.get('location');
    if (!location) throw new Error('Mailbox usage report did not return a download URL');
    const csvRes = await fetch(location);
    if (!csvRes.ok) throw new Error(`Mailbox usage report download failed ${csvRes.status}`);
    return csvRes.text();
  }
  if (!reportRes.ok) {
    const raw = await reportRes.text().catch(() => '');
    let err = {};
    try { err = raw ? JSON.parse(raw) : {}; } catch (_) {}
    throw new Error(err.error?.message || raw || `Mailbox usage report error ${reportRes.status}`);
  }
  return reportRes.text();
}

async function getMailboxUsageReport(email) {
  let token = (await graph.getClientCredentialsToken().catch(() => null))
    || await graph.getAccessToken(email);
  try {
    return parseMailboxUsageCsv(await downloadMailboxUsageReport(token), email);
  } catch (err) {
    const shouldRefresh = /401|403|privilege|permission|authorization|access/i.test(err.message || '');
    if (!shouldRefresh) throw err;
    token = (await graph.getClientCredentialsToken(true).catch(() => null)) || token;
    return parseMailboxUsageCsv(await downloadMailboxUsageReport(token), email);
  }
}

function folderStorageKind(displayName) {
  const name = String(displayName || '').trim().toLowerCase();
  if (name === 'inbox') return 'inbox';
  if (name === 'sent items' || name === 'sentitems') return 'sent';
  if (name === 'deleted items' || name === 'deleteditems') return 'deleted';
  if (name === 'junk email' || name === 'junkemail') return 'junk';
  if (name === 'drafts') return 'drafts';
  if (name === 'archive') return 'archive';
  return 'other';
}

function readMessageSize(message) {
  const props = message.singleValueExtendedProperties || [];
  const wanted = new Set(MESSAGE_SIZE_PROPS.map(p => p.toLowerCase()));
  const prop = props.find(p => wanted.has(String(p.id || '').toLowerCase()));
  const n = Number(prop && prop.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function fetchJsonWithGraphToken(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Graph API error ${res.status}`);
  }
  return res.json();
}

async function scanFolderMessageSizes(folder, token, email) {
  const propFilter = MESSAGE_SIZE_PROPS.map(p => `id eq '${p}'`).join(' or ');
  const params = new URLSearchParams({
    '$top': '999',
    '$select': 'id',
    '$expand': `singleValueExtendedProperties($filter=${propFilter})`,
  });
  let url = `${GRAPH_ROOT}/users/${encodeURIComponent(email)}/mailFolders/${encodeURIComponent(folder.id)}/messages?${params}`;
  let bytes = 0;
  let scanned = 0;
  let sized = 0;

  while (url) {
    const data = await fetchJsonWithGraphToken(url, token);
    const messages = data.value || [];
    for (const message of messages) {
      const size = readMessageSize(message);
      bytes += size;
      if (size > 0) sized++;
      scanned++;
    }
    url = data['@odata.nextLink'] || '';
  }

  return {
    folderId: folder.id,
    displayName: folder.displayName,
    bytes,
    scanned,
    sized,
    kind: folderStorageKind(folder.displayName),
  };
}

async function getLiveFolderStorageStats(folders, email) {
  const cacheKey = `${email}:${folders.map(f => `${f.id}:${f.totalItemCount || 0}`).join('|')}`;
  if (
    storageScanCache &&
    storageScanCache.key === cacheKey &&
    storageScanCache.expiresAt > Date.now()
  ) {
    return storageScanCache.value;
  }

  const token = await graph.getAccessToken(email);
  if (!token) throw new Error('NOT_AUTHENTICATED');

  const scanFolders = (folders || [])
    .filter(f => f && f.id && Number(f.totalItemCount || 0) > 0);
  const results = [];
  let index = 0;
  const concurrency = Math.min(3, Math.max(1, scanFolders.length));

  async function worker() {
    while (index < scanFolders.length) {
      const folder = scanFolders[index++];
      results.push(await scanFolderMessageSizes(folder, token, email));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const folderBytesById = {};
  const buckets = { inbox: 0, sent: 0, deleted: 0, junk: 0, drafts: 0, archive: 0, other: 0 };
  let totalBytes = 0;
  let scannedMessages = 0;
  let sizedMessages = 0;
  for (const item of results) {
    folderBytesById[item.folderId] = item.bytes;
    buckets[item.kind] = (buckets[item.kind] || 0) + item.bytes;
    totalBytes += item.bytes;
    scannedMessages += item.scanned;
    sizedMessages += item.sized;
  }

  const value = {
    source: 'message-scan',
    totalBytes,
    scannedMessages,
    sizedMessages,
    folderBytesById,
    buckets,
    scannedAt: new Date().toISOString(),
  };
  storageScanCache = { key: cacheKey, expiresAt: Date.now() + STORAGE_SCAN_CACHE_MS, value };
  return value;
}

function readOutlookStorageSnapshot() {
  try {
    if (!fs.existsSync(STORAGE_SNAPSHOT_PATH)) return null;
    return JSON.parse(fs.readFileSync(STORAGE_SNAPSHOT_PATH, 'utf8'));
  } catch (err) {
    console.warn('[Outlook Storage] Snapshot read failed:', err.message);
    return null;
  }
}

function storageFolderKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function ensureSignatureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlook_signatures (
      id                SERIAL PRIMARY KEY,
      user_email        VARCHAR(200) NOT NULL,
      name              VARCHAR(200) NOT NULL,
      html_body         TEXT NOT NULL,
      is_default_new    BOOLEAN DEFAULT FALSE,
      is_default_reply  BOOLEAN DEFAULT FALSE,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outlook_signatures_email ON outlook_signatures (user_email)`);
}

async function getSignatureRows() {
  await ensureSignatureTable();
  const r = await pool.query(
    `SELECT id, name, html_body, is_default_new, is_default_reply, created_at, updated_at
     FROM outlook_signatures
     WHERE user_email = $1
     ORDER BY created_at ASC, id ASC`,
    [MS_EMAIL]
  );
  return r.rows;
}

async function setSignatureDefault(kind, id) {
  await ensureSignatureTable();
  const column = kind === 'reply' ? 'is_default_reply' : 'is_default_new';
  await pool.query(`UPDATE outlook_signatures SET ${column}=FALSE WHERE user_email=$1`, [MS_EMAIL]);
  if (id) {
    const r = await pool.query(
      `UPDATE outlook_signatures SET ${column}=TRUE, updated_at=NOW() WHERE user_email=$1 AND id=$2 RETURNING id`,
      [MS_EMAIL, id]
    );
    if (!r.rows.length) throw new Error('Signature not found');
  }
}

async function fetchAllOutlookContactsGraph(email) {
  contactsTraceLog(`[Outlook Contacts][STEP 1] Starting mailbox contacts fetch for MS_USER_EMAIL="${email || ''}"`);
  // Try delegated token first (has access to personal "Your contacts" folder)
  // Fall back to client credentials (works if Contacts.ReadWrite Application permission granted)
  let token = await graph.getAccessTokenForScopes(email, [
    'https://graph.microsoft.com/Contacts.ReadWrite',
    'https://graph.microsoft.com/Mail.Read',
    'offline_access',
  ]);
  let tokenType = 'delegated';
  if (!token) {
    token = await graph.getClientCredentialsToken();
    tokenType = 'client-credentials';
  }
  if (!token) throw new Error('NOT_AUTHENTICATED');
  contactsTraceLog(`[Outlook Contacts] Using ${tokenType} token for contacts fetch`);
  // homePhones added — many contacts store phone there instead of mobilePhone
  const sel = 'id,displayName,givenName,surname,emailAddresses,businessPhones,mobilePhone,homePhones,companyName,jobTitle';
  const rows = [];
  lastContactsTrace.contacts = {
    mailbox: email,
    token: summarizeGraphToken(token),
    select: sel,
    endpoints: [],
    folders: [],
  };
  contactsTraceLog('[Outlook Contacts][TRACE] Token permission summary:', lastContactsTrace.contacts.token);
  tracePermissionDecision('mailbox-contacts', lastContactsTrace.contacts.token, ['Contacts.Read', 'Contacts.ReadWrite']);
  contactsTraceLog('[Outlook Contacts][TRACE] Contact fields selected:', sel);

  async function readPages(firstUrl, label = 'contacts') {
    contactsTraceLog(`[Outlook Contacts][STEP 2] Reading Graph pages label="${label}" url="${firstUrl}"`);
    let url = firstUrl;
    for (let page = 0; page < 100 && url; page++) {
      const traceItem = { label, page, url, status: null, count: 0, next: false };
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      traceItem.status = res.status;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        traceItem.error = err.error?.message || `Graph API error ${res.status}`;
        lastContactsTrace.contacts.endpoints.push(traceItem);
        contactsTraceWarn('[Outlook Contacts][TRACE] Graph page failed:', traceItem);
        const graphErr = new Error(err.error?.message || `Graph API error ${res.status}`);
        graphErr.status = res.status;
        graphErr.code = err.error?.code;
        throw graphErr;
      }
      const data = await res.json();
      const pageRows = data.value || [];
      rows.push(...pageRows);
      url = data['@odata.nextLink'] || null;
      traceItem.count = pageRows.length;
      traceItem.withPhone = pageRows.filter(c => contactPhoneSummary(c).hasAnyPhone).length;
      traceItem.next = !!url;
      lastContactsTrace.contacts.endpoints.push(traceItem);
      contactsTraceLog('[Outlook Contacts][TRACE] Graph page:', traceItem);
      traceContactSample(`${label}:page-${page}`, pageRows, 3);
    }
  }

  // Strategy: fetch from ALL contact folders (not just default)
  // This ensures "Your contacts" and other named folders are included
  const useUserEndpoint = email && email !== 'me';
  const baseUrl = useUserEndpoint
    ? `${GRAPH_ROOT}/users/${encodeURIComponent(email)}`
    : `${GRAPH_ROOT}/me`;

  // Step 1: Get all contact folders
  let folderIds = [];
  try {
    const foldersUrl = `${baseUrl}/contactFolders?$top=100&$select=id,displayName`;
    contactsTraceLog(`[Outlook Contacts][STEP 3] Listing contact folders url="${foldersUrl}"`);
    const fRes = await fetch(foldersUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    lastContactsTrace.contacts.folderList = { url: foldersUrl, status: fRes.status, count: 0 };
    if (fRes.ok) {
      const fData = await fRes.json();
      folderIds = (fData.value || []).map(f => ({ id: f.id, name: f.displayName }));
      lastContactsTrace.contacts.folderList.count = folderIds.length;
      lastContactsTrace.contacts.folders = folderIds.map(f => ({
        name: f.name,
        idPreview: String(f.id || '').slice(0, 18) + '...',
      }));
      contactsTraceLog(`[Outlook Contacts] Found ${folderIds.length} contact folders:`, folderIds.map(f => f.name).join(', '));
      contactsTraceLog('[Outlook Contacts][TRACE] Contact folders:', lastContactsTrace.contacts.folders);
    } else {
      const err = await fRes.json().catch(() => ({}));
      lastContactsTrace.contacts.folderList.error = err.error?.message || `Graph API error ${fRes.status}`;
      contactsTraceWarn('[Outlook Contacts][TRACE] Contact folder list failed:', lastContactsTrace.contacts.folderList);
    }
  } catch (fErr) {
    contactsTraceWarn('[Outlook Contacts] Could not fetch contact folders:', fErr.message);
  }

  // Step 2: Fetch contacts from default folder
  const defaultUrl = `${baseUrl}/contacts?$top=500&$select=${encodeURIComponent(sel)}`;
  try {
    contactsTraceLog('[Outlook Contacts][STEP 4] Fetching default Contacts folder');
    await readPages(defaultUrl, 'default-contacts');
    contactsTraceLog(`[Outlook Contacts] Default folder: ${rows.length} contacts`);
    traceContactSample('after-default-contacts', rows);
  } catch (err) {
    contactsTraceWarn('[Outlook Contacts] Default folder fetch failed:', err.message);
    // Try /me fallback
    if (useUserEndpoint) {
      try {
        rows.length = 0;
        await readPages(`${GRAPH_ROOT}/me/contacts?$top=500&$select=${encodeURIComponent(sel)}`, 'me-fallback-contacts');
        contactsTraceLog(`[Outlook Contacts] /me fallback: ${rows.length} contacts`);
      } catch (e2) {
        contactsTraceWarn('[Outlook Contacts] /me fallback also failed:', e2.message);
      }
    }
  }

  // Step 3: Fetch contacts from each named folder (to get "Your contacts" etc.)
  const seenIds = new Set(rows.map(r => r.id));
  contactsTraceLog(`[Outlook Contacts][STEP 5] Fetching ${folderIds.length} named contact folders`);
  for (const folder of folderIds) {
    try {
      const folderUrl = `${baseUrl}/contactFolders/${encodeURIComponent(folder.id)}/contacts?$top=500&$select=${encodeURIComponent(sel)}`;
      const beforeCount = rows.length;
      const folderRows = [];
      let url = folderUrl;
      for (let page = 0; page < 100 && url; page++) {
        const traceItem = { label: `folder:${folder.name}`, page, url, status: null, count: 0, newUniqueCount: 0, next: false };
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        traceItem.status = res.status;
        if (!res.ok) {
          traceItem.error = `Graph API error ${res.status}`;
          lastContactsTrace.contacts.endpoints.push(traceItem);
          contactsTraceWarn('[Outlook Contacts][TRACE] Folder page failed:', traceItem);
          break;
        }
        const data = await res.json();
        const uniqueBefore = folderRows.length;
        for (const c of (data.value || [])) {
          if (!seenIds.has(c.id)) {
            seenIds.add(c.id);
            folderRows.push(c);
          }
        }
        url = data['@odata.nextLink'] || null;
        traceItem.count = (data.value || []).length;
        traceItem.newUniqueCount = folderRows.length - uniqueBefore;
        traceItem.withPhone = (data.value || []).filter(c => contactPhoneSummary(c).hasAnyPhone).length;
        traceItem.next = !!url;
        lastContactsTrace.contacts.endpoints.push(traceItem);
        contactsTraceLog('[Outlook Contacts][TRACE] Folder Graph page:', traceItem);
        traceContactSample(`folder:${folder.name}:page-${page}`, data.value || [], 3);
      }
      rows.push(...folderRows);
      if (folderRows.length > 0) {
        contactsTraceLog(`[Outlook Contacts] Folder "${folder.name}": +${folderRows.length} new contacts (total now: ${rows.length})`);
        traceContactSample(`folder:${folder.name}:new-unique`, folderRows);
      } else {
        contactsTraceLog(`[Outlook Contacts] Folder "${folder.name}": 0 new unique contacts (total still: ${rows.length}, before: ${beforeCount})`);
      }
    } catch (fErr) {
      contactsTraceWarn(`[Outlook Contacts] Folder "${folder.name}" fetch failed:`, fErr.message);
    }
  }

  // Step 4: Always include delegated /me contacts too. Outlook personal People
  // contacts are user-scoped; /users/{mailbox}/contacts can miss entries even
  // when the signed-in mailbox is the same account.
  const contactTokenSummary = lastContactsTrace.contacts && lastContactsTrace.contacts.token;
  const canUseMeEndpoint = contactTokenSummary && contactTokenSummary.tokenType === 'delegated';
  if (useUserEndpoint && canUseMeEndpoint) {
    const beforeMe = rows.length;
    const meRows = [];
    async function readMePages(firstUrl, label) {
      contactsTraceLog(`[Outlook Contacts][STEP 6] Reading delegated /me supplement label="${label}" url="${firstUrl}"`);
      let url = firstUrl;
      for (let page = 0; page < 100 && url; page++) {
        const traceItem = { label, page, url, status: null, count: 0, newUniqueCount: 0, next: false };
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        traceItem.status = res.status;
        if (!res.ok) {
          traceItem.error = `Graph API error ${res.status}`;
          lastContactsTrace.contacts.endpoints.push(traceItem);
          contactsTraceWarn('[Outlook Contacts][TRACE] /me page failed:', traceItem);
          break;
        }
        const data = await res.json();
        const uniqueBefore = meRows.length;
        for (const c of (data.value || [])) {
          if (!seenIds.has(c.id)) {
            seenIds.add(c.id);
            meRows.push(c);
          }
        }
        url = data['@odata.nextLink'] || null;
        traceItem.count = (data.value || []).length;
        traceItem.newUniqueCount = meRows.length - uniqueBefore;
        traceItem.withPhone = (data.value || []).filter(c => contactPhoneSummary(c).hasAnyPhone).length;
        traceItem.next = !!url;
        lastContactsTrace.contacts.endpoints.push(traceItem);
        contactsTraceLog('[Outlook Contacts][TRACE] /me Graph page:', traceItem);
        traceContactSample(`${label}:page-${page}`, data.value || [], 3);
      }
    }

    await readMePages(`${GRAPH_ROOT}/me/contacts?$top=500&$select=${encodeURIComponent(sel)}`, 'me-contacts');
    try {
      contactsTraceLog('[Outlook Contacts][STEP 7] Listing delegated /me contact folders');
      const fRes = await fetch(`${GRAPH_ROOT}/me/contactFolders?$top=100&$select=id,displayName`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (fRes.ok) {
        const fData = await fRes.json();
        const meFolders = fData.value || [];
        lastContactsTrace.contacts.meFolders = meFolders.map(f => ({ name: f.displayName, idPreview: String(f.id || '').slice(0, 18) + '...' }));
        contactsTraceLog(`[Outlook Contacts][TRACE] /me contact folders found: ${meFolders.map(f => f.displayName).join(', ')}`);
        for (const folder of meFolders) {
          await readMePages(`${GRAPH_ROOT}/me/contactFolders/${encodeURIComponent(folder.id)}/contacts?$top=500&$select=${encodeURIComponent(sel)}`, `me-folder:${folder.displayName}`);
        }
      } else {
        const err = await fRes.json().catch(() => ({}));
        contactsTraceWarn('[Outlook Contacts][TRACE] /me contact folders failed:', {
          status: fRes.status,
          error: err.error?.message || `Graph API error ${fRes.status}`,
        });
      }
    } catch (meFolderErr) {
      contactsTraceWarn('[Outlook Contacts] /me contact folders fetch failed:', meFolderErr.message);
    }
    rows.push(...meRows);
    lastContactsTrace.contacts.meSupplementalAdded = rows.length - beforeMe;
    contactsTraceLog(`[Outlook Contacts] /me supplemental: +${rows.length - beforeMe} contacts (total now: ${rows.length})`);
    traceContactSample('after-me-supplement', rows);
  } else if (useUserEndpoint) {
    lastContactsTrace.contacts.meSupplementalSkipped = contactTokenSummary && contactTokenSummary.tokenType
      ? `Skipped /me supplemental fetch for ${contactTokenSummary.tokenType} token`
      : 'Skipped /me supplemental fetch because token type is unknown';
    contactsTraceLog(`[Outlook Contacts][STEP 6] ${lastContactsTrace.contacts.meSupplementalSkipped}`);
  }

  // Log contacts with phone numbers
  const withPhone = rows.filter(c => c.mobilePhone || (c.businessPhones && c.businessPhones.length) || (c.homePhones && c.homePhones.length));
  lastContactsTrace.contacts.totalFetched = rows.length;
  lastContactsTrace.contacts.withPhone = withPhone.length;
  contactsTraceLog(`[Outlook Contacts] Total fetched: ${rows.length} | With phone: ${withPhone.length}`);
  traceContactSample('raw-mailbox-final-before-map', rows, 12);
  withPhone.forEach((c, i) => {
    contactsTraceLog(`[Outlook Contacts][phone][${i}] "${c.displayName}" | mobile="${c.mobilePhone}" | business=${JSON.stringify(c.businessPhones)} | home=${JSON.stringify(c.homePhones)} | email=${JSON.stringify((c.emailAddresses||[]).map(e=>e.address))}`);
  });

  return rows;
}

function mapOutlookContactToDirectoryItem(contact) {
  const email = (contact.emailAddresses || []).map(e => e && e.address).filter(Boolean)[0] || '';
  const displayName = contact.displayName
    || [contact.givenName, contact.surname].filter(Boolean).join(' ')
    || email
    || 'Outlook contact';

  // Resolve best phone: mobilePhone > businessPhones > homePhones
  const resolvedPhone = contact.mobilePhone
    || (Array.isArray(contact.businessPhones) && contact.businessPhones.find(Boolean))
    || (Array.isArray(contact.homePhones) && contact.homePhones.find(Boolean))
    || null;
  const resolvedPhoneSource = contact.mobilePhone
    ? 'mobilePhone'
    : ((Array.isArray(contact.businessPhones) && contact.businessPhones.find(Boolean))
      ? 'businessPhones'
      : ((Array.isArray(contact.homePhones) && contact.homePhones.find(Boolean)) ? 'homePhones' : 'none'));

  return {
    ...contact,
    displayName,
    mobilePhone: resolvedPhone || contact.mobilePhone || null,
    resolvedPhone,
    resolvedPhoneSource,
    source: 'outlook-contacts',
    outlookPeopleUrl: `https://outlook.cloud.microsoft/people/?q=${encodeURIComponent(email || displayName)}`,
  };
}

async function fetchAllOutlookPeopleGraphSafe(email) {
  try {
    return await fetchAllOutlookPeopleGraph(email);
  } catch (err) {
    lastContactsTrace.people = {
      ...(lastContactsTrace.people || {}),
      error: err.message,
      status: err.status || null,
      code: err.code || null,
    };
    contactsTraceWarn('[Outlook People][TRACE] People API merge failed:', lastContactsTrace.people);
    return [];
  }
}

function mapOutlookPersonToContact(person) {
  const scored = Array.isArray(person.scoredEmailAddresses) ? person.scoredEmailAddresses : [];
  const email = scored.map(e => e && e.address).filter(Boolean)[0]
    || person.userPrincipalName
    || '';
  const phones = Array.isArray(person.phones) ? person.phones : [];
  const mobile = phones.find(p => /mobile/i.test(String(p.type || '')));
  const phone = (mobile && mobile.number) || (phones.find(p => p && p.number) || {}).number || '';
  const displayName = person.displayName || email || 'Outlook contact';
  const nameParts = String(displayName).trim().split(/\s+/).filter(Boolean);
  return {
    id: `person:${person.id}`,
    outlookPersonId: person.id,
    displayName,
    givenName: person.givenName || nameParts[0] || '',
    surname: person.surname || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : ''),
    emailAddresses: email ? [{ name: displayName, address: email }] : [],
    mobilePhone: phone || null,
    businessPhones: phone ? [phone] : [],
    resolvedPhone: phone || null,
    resolvedPhoneSource: phone ? 'outlookPeopleSearch' : 'none',
    companyName: person.companyName || null,
    jobTitle: person.jobTitle || null,
    source: 'outlook-people',
    outlookPeopleUrl: `https://outlook.cloud.microsoft/people/?q=${encodeURIComponent(email || displayName)}`,
  };
}

function normalizeSearchEmailAddresses(value, displayName) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        return item.address || item.emailAddress || item.email || '';
      })
      .map(address => String(address || '').trim())
      .filter(Boolean)
      .map(address => ({ name: displayName || address, address }));
  }
  if (typeof value === 'string') {
    return value.split(/[;,]/)
      .map(address => String(address || '').trim())
      .filter(Boolean)
      .map(address => ({ name: displayName || address, address }));
  }
  return [];
}

function normalizeSearchPhones(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .map(item => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      return item.number || item.phoneNumber || item.value || '';
    })
    .map(phone => String(phone || '').trim())
    .filter(Boolean);
}

function mapSearchPersonToContact(person) {
  const displayName = person.displayName || person.name || person.email || 'Outlook person';
  const emailAddresses = normalizeSearchEmailAddresses(
    person.emailAddresses || person.emailAddress || person.emails || person.email,
    displayName
  );
  const phones = normalizeSearchPhones(person.phones || person.businessPhones || person.mobilePhone || person.phoneNumbers);
  const phone = phones[0] || null;
  const primaryEmail = (emailAddresses[0] && emailAddresses[0].address) || '';
  const nameParts = String(displayName || primaryEmail).trim().split(/\s+/).filter(Boolean);
  return {
    id: `search-person:${person.id || primaryEmail || displayName}`,
    outlookPersonId: person.id || null,
    displayName: displayName || primaryEmail || 'Outlook person',
    givenName: person.givenName || nameParts[0] || '',
    surname: person.surname || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : ''),
    emailAddresses,
    mobilePhone: phone,
    businessPhones: phone ? [phone] : [],
    resolvedPhone: phone,
    resolvedPhoneSource: phone ? 'microsoftSearchPerson' : 'none',
    companyName: person.companyName || person.company || null,
    jobTitle: person.jobTitle || null,
    source: 'outlook-people',
    outlookPeopleUrl: `https://outlook.cloud.microsoft/people/?q=${encodeURIComponent(primaryEmail || displayName)}`,
  };
}

function orgContactPrimaryEmail(contact) {
  return contact.mail
    || (Array.isArray(contact.proxyAddresses)
      ? contact.proxyAddresses.map(v => String(v || '').replace(/^smtp:/i, '').trim()).find(Boolean)
      : '')
    || '';
}

function orgContactPrimaryPhone(contact) {
  const phones = Array.isArray(contact.phones) ? contact.phones : [];
  const mobile = phones.find(p => /mobile/i.test(String(p && p.type || '')));
  return (mobile && mobile.number)
    || (phones.find(p => p && p.number) || {}).number
    || contact.mobilePhone
    || (Array.isArray(contact.businessPhones) && contact.businessPhones.find(Boolean))
    || null;
}

function mapOrgContactToDirectoryItem(contact) {
  const email = orgContactPrimaryEmail(contact);
  const phone = orgContactPrimaryPhone(contact);
  const displayName = contact.displayName || email || 'Organizational contact';
  const nameParts = String(displayName).trim().split(/\s+/).filter(Boolean);
  return {
    id: `orgcontact:${contact.id}`,
    orgContactId: contact.id,
    displayName,
    givenName: contact.givenName || nameParts[0] || '',
    surname: contact.surname || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : ''),
    emailAddresses: email ? [{ name: displayName, address: email }] : [],
    mobilePhone: phone || null,
    businessPhones: phone ? [phone] : [],
    resolvedPhone: phone || null,
    resolvedPhoneSource: phone ? 'orgContact.phones' : 'none',
    companyName: contact.companyName || null,
    jobTitle: contact.jobTitle || null,
    source: 'outlook-org-contacts',
    outlookPeopleUrl: `https://outlook.cloud.microsoft/people/?q=${encodeURIComponent(email || displayName)}`,
  };
}

function directoryPrimaryEmail(contact) {
  return ((contact.emailAddresses || []).map(e => e && e.address).filter(Boolean)[0] || '').trim();
}

function directoryPrimaryPhone(contact) {
  return (contact.resolvedPhone && String(contact.resolvedPhone).trim())
    || (contact.mobilePhone && String(contact.mobilePhone).trim())
    || (Array.isArray(contact.businessPhones) && contact.businessPhones.map(p => String(p || '').trim()).find(Boolean))
    || (Array.isArray(contact.homePhones) && contact.homePhones.map(p => String(p || '').trim()).find(Boolean))
    || null;
}

function normalizeDirectoryPhoneFields(contact) {
  if (!contact) return contact;
  const phone = directoryPrimaryPhone(contact);
  if (!phone) return contact;

  // Keep mobilePhone populated because CRM, WhatsApp matching, and call-log
  // matching all consume this field first.
  if (!contact.mobilePhone) contact.mobilePhone = phone;
  if (!contact.resolvedPhone) contact.resolvedPhone = phone;
  if (!contact.resolvedPhoneSource) contact.resolvedPhoneSource = 'normalized';
  return contact;
}

function mergeOutlookGraphMarker(notes, graphId) {
  const marker = `Outlook contact · Graph ID: ${graphId}`;
  const current = String(notes || '').trim();
  if (!graphId) return current || null;
  if (!current) return marker;
  if (/Graph ID:/i.test(current)) return current.replace(/Outlook contact\s*·\s*Graph ID:\s*[^\s,\n]+/i, marker);
  return `${current}\n${marker}`;
}

function directoryContactRank(contact) {
  const email = directoryPrimaryEmail(contact).toLowerCase();
  const name = String(contact.displayName || '').trim().toLowerCase();
  const hasUsefulName = !!name && name !== email;
  const hasPhone = !!directoryPrimaryPhone(contact);
  const sourceRank = contact.source === 'outlook-contacts'
    ? 100
    : (contact.source === 'outlook-org-contacts' ? 70 : (contact.source === 'outlook-people' ? 40 : 10));
  return sourceRank + (hasUsefulName ? 20 : 0) + (hasPhone ? 10 : 0);
}

function mergeDirectoryContact(existing, incoming) {
  const incomingPhone = directoryPrimaryPhone(incoming);
  const existingEmail = directoryPrimaryEmail(existing).toLowerCase();
  const existingName = String(existing.displayName || '').trim();
  const incomingName = String(incoming.displayName || '').trim();
  const existingLooksLikeEmail = existingName && existingName.toLowerCase() === existingEmail;
  const incomingLooksUseful = incomingName && incomingName.toLowerCase() !== directoryPrimaryEmail(incoming).toLowerCase();

  if ((!existingName || existingLooksLikeEmail) && incomingLooksUseful) {
    existing.displayName = incomingName;
    existing.givenName = incoming.givenName || existing.givenName || '';
    existing.surname = incoming.surname || existing.surname || '';
  }
  if (!directoryPrimaryPhone(existing) && incomingPhone) {
    existing.mobilePhone = incoming.mobilePhone || incomingPhone;
    existing.businessPhones = incoming.businessPhones || existing.businessPhones || [];
    existing.homePhones = incoming.homePhones || existing.homePhones || [];
    existing.resolvedPhone = incoming.resolvedPhone || incomingPhone;
    existing.resolvedPhoneSource = incoming.resolvedPhoneSource || incoming.source || 'merged';
  }
  if (!existing.companyName && incoming.companyName) existing.companyName = incoming.companyName;
  if (!existing.jobTitle && incoming.jobTitle) existing.jobTitle = incoming.jobTitle;
  if (!existing.displayName && incoming.displayName) existing.displayName = incoming.displayName;
  if (incoming.orgContactId && !existing.orgContactId) existing.orgContactId = incoming.orgContactId;
  if (incoming.outlookPersonId && !existing.outlookPersonId) existing.outlookPersonId = incoming.outlookPersonId;
  normalizeDirectoryPhoneFields(existing);
}

function collapseDirectoryContactsByEmail(contacts) {
  const result = [];
  const byEmail = new Map();
  for (const contact of contacts || []) {
    normalizeDirectoryPhoneFields(contact);
    const email = directoryPrimaryEmail(contact).toLowerCase();
    if (!email) {
      result.push(contact);
      continue;
    }

    const existing = byEmail.get(email);
    if (!existing) {
      byEmail.set(email, contact);
      result.push(contact);
      continue;
    }

    if (directoryContactRank(contact) > directoryContactRank(existing)) {
      mergeDirectoryContact(contact, existing);
      const index = result.indexOf(existing);
      if (index >= 0) result[index] = contact;
      byEmail.set(email, contact);
    } else {
      mergeDirectoryContact(existing, contact);
    }
  }
  return result;
}

function appendUniqueDirectoryContacts(base, incoming) {
  const byEmail = new Map();
  const byId = new Map();
  for (const contact of base) {
    const email = directoryPrimaryEmail(contact).toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, contact);
    if (contact.id) byId.set(String(contact.id), contact);
  }

  let merged = 0;
  let appended = 0;
  for (const contact of incoming || []) {
    const email = directoryPrimaryEmail(contact).toLowerCase();
    const id = contact.id ? String(contact.id) : '';
    const existing = (email && byEmail.get(email)) || (id && byId.get(id));
    if (existing) {
      if (email && directoryContactRank(contact) > directoryContactRank(existing)) {
        mergeDirectoryContact(contact, existing);
        const index = base.indexOf(existing);
        if (index >= 0) base[index] = contact;
        byEmail.set(email, contact);
        if (id) byId.set(id, contact);
      } else {
        mergeDirectoryContact(existing, contact);
      }
      merged++;
      continue;
    }
    base.push(contact);
    normalizeDirectoryPhoneFields(contact);
    if (email) byEmail.set(email, contact);
    if (id) byId.set(id, contact);
    appended++;
  }
  return { merged, appended };
}

async function getOutlookPeopleTokenContext(email) {
  const requestedScopes = [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Contacts.ReadWrite',
    'https://graph.microsoft.com/MailboxSettings.ReadWrite',
    'https://graph.microsoft.com/People.Read',
    'offline_access',
  ];
  const scopedToken = await graph.getAccessTokenForScopes(email, requestedScopes);
  const regularToken = scopedToken || await graph.getAccessToken(email);
  const regularSummary = regularToken ? summarizeGraphToken(regularToken) : null;
  const usingDelegatedToken = !!(regularSummary && regularSummary.tokenType === 'delegated');
  const graphToken = regularToken || await graph.getClientCredentialsToken(true);
  if (!graphToken) throw new Error('NOT_AUTHENTICATED');
  return {
    requestedScopes,
    graphToken,
    authMode: usingDelegatedToken ? 'delegated' : 'application',
    peopleEndpoint: usingDelegatedToken
      ? `${GRAPH_ROOT}/me/people`
      : `${GRAPH_ROOT}/users/${encodeURIComponent(email)}/people`,
  };
}

async function fetchOutlookDirectoryItems(email) {
  contactsTraceLog(`[Outlook Contacts][STEP 8] Building unified Outlook directory for "${email || ''}"`);
  let outlookContacts = collapseDirectoryContactsByEmail((await fetchAllOutlookContactsGraph(email)).map(mapOutlookContactToDirectoryItem));
  traceContactSample('mapped-mailbox-contacts', outlookContacts, 12);
  let peopleList = [];

  try {
    contactsTraceLog('[Outlook Contacts][STEP 9] Fetching People API list for suggested/relevant people merge');
    peopleList = await fetchAllOutlookPeopleGraphSafe(email);
    traceContactSample('people-api-before-merge', peopleList, 12);
    if (peopleList && peopleList.length > 0) {
      const peopleMerge = appendUniqueDirectoryContacts(outlookContacts, peopleList);
      lastContactsTrace.people.phoneMapSize = peopleList.filter(directoryPrimaryPhone).length;
      lastContactsTrace.people.mergedIntoContacts = peopleMerge.merged;
      lastContactsTrace.people.appendedToContacts = peopleMerge.appended;
      contactsTraceLog(`[Outlook People][TRACE] Merged ${peopleMerge.merged}, appended ${peopleMerge.appended}`);
      traceContactSample('after-people-merge', outlookContacts, 12);
    } else {
      contactsTraceLog('[Outlook People][TRACE] People API returned 0 contacts; no merge happened');
    }
  } catch (peopleErr) {
    contactsTraceWarn('[Outlook Contacts] People API merge failed (non-fatal):', peopleErr.message);
  }

  try {
    contactsTraceLog('[Outlook Contacts][STEP 10] Fetching OrgContact list for tenant/global contacts merge');
    const orgContacts = await fetchAllOrgContactsGraphSafe();
    traceContactSample('orgcontacts-before-merge', orgContacts, 12);
    if (orgContacts && orgContacts.length > 0) {
      const orgMerge = appendUniqueDirectoryContacts(outlookContacts, orgContacts);
      lastContactsTrace.orgContacts.mergedIntoContacts = orgMerge.merged;
      lastContactsTrace.orgContacts.appendedToContacts = orgMerge.appended;
      contactsTraceLog(`[Outlook OrgContacts][TRACE] Merged ${orgMerge.merged}, appended ${orgMerge.appended}`);
      traceContactSample('after-orgcontacts-merge', outlookContacts, 12);
    } else {
      contactsTraceLog('[Outlook OrgContacts][TRACE] OrgContact API returned 0 contacts; no merge happened');
    }
  } catch (orgErr) {
    contactsTraceWarn('[Outlook Contacts] Org contacts merge failed (non-fatal):', orgErr.message);
  }

  outlookContacts.sort((a, b) => {
    const na = (a.displayName || directoryPrimaryEmail(a) || '').trim();
    const nb = (b.displayName || directoryPrimaryEmail(b) || '').trim();
    return na.localeCompare(nb, undefined, { sensitivity: 'base' });
  });
  outlookContacts.forEach(normalizeDirectoryPhoneFields);

  traceContactSample('final-directory-items', outlookContacts, 15);
  return outlookContacts;
}

async function fetchAllOrgContactsGraphSafe() {
  try {
    return await fetchAllOrgContactsGraph();
  } catch (err) {
    lastContactsTrace.orgContacts = {
      ...(lastContactsTrace.orgContacts || {}),
      error: err.message,
      status: err.status || null,
      code: err.code || null,
      requiredPermission: 'OrgContact.Read.All',
    };
    contactsTraceWarn('[Outlook OrgContacts][TRACE] Org contacts fetch failed:', lastContactsTrace.orgContacts);
    return [];
  }
}

async function fetchAllOrgContactsGraph() {
  const token = await graph.getClientCredentialsToken(true) || await graph.getAccessToken(MS_EMAIL);
  if (!token) throw new Error('NOT_AUTHENTICATED');
  const sel = 'id,displayName,givenName,surname,mail,proxyAddresses,phones,companyName,jobTitle';
  let url = `${GRAPH_ROOT}/contacts?$top=999&$select=${encodeURIComponent(sel)}`;
  const rows = [];
  lastContactsTrace.orgContacts = {
    token: summarizeGraphToken(token),
    select: sel,
    endpoint: '/contacts',
    requiredPermission: 'OrgContact.Read.All',
    pages: [],
  };
  contactsTraceLog('[Outlook OrgContacts][TRACE] Token permission summary:', lastContactsTrace.orgContacts.token);
  tracePermissionDecision('orgcontacts', lastContactsTrace.orgContacts.token, ['OrgContact.Read.All']);
  contactsTraceLog('[Outlook OrgContacts][TRACE] OrgContact fields selected:', sel);
  for (let page = 0; page < 20 && url; page++) {
    const traceItem = { page, url, status: null, count: 0, next: false };
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    traceItem.status = res.status;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      traceItem.error = err.error?.message || `Graph API error ${res.status}`;
      lastContactsTrace.orgContacts.pages.push(traceItem);
      contactsTraceWarn('[Outlook OrgContacts][TRACE] Graph page failed:', traceItem);
      const graphErr = new Error(traceItem.error);
      graphErr.status = res.status;
      graphErr.code = err.error?.code;
      throw graphErr;
    }
    const data = await res.json();
    const pageRows = data.value || [];
    rows.push(...pageRows.map(mapOrgContactToDirectoryItem));
    url = data['@odata.nextLink'] || null;
    traceItem.count = pageRows.length;
    traceItem.withPhone = pageRows.filter(c => orgContactPrimaryPhone(c)).length;
    traceItem.next = !!url;
    lastContactsTrace.orgContacts.pages.push(traceItem);
    contactsTraceLog('[Outlook OrgContacts][TRACE] Graph page:', traceItem);
    traceContactSample(`orgcontacts:page-${page}`, pageRows.map(mapOrgContactToDirectoryItem), 3);
  }
  lastContactsTrace.orgContacts.totalFetched = rows.length;
  lastContactsTrace.orgContacts.withPhone = rows.filter(c => c.mobilePhone || (c.businessPhones && c.businessPhones.length)).length;
  contactsTraceLog(`[Outlook OrgContacts][TRACE] Total fetched: ${rows.length} | With phone: ${lastContactsTrace.orgContacts.withPhone}`);
  traceContactSample('orgcontacts-final', rows, 12);
  return rows;
}

async function fetchAllOutlookPeopleGraph(email) {
  const requestedScopes = [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Contacts.ReadWrite',
    'https://graph.microsoft.com/MailboxSettings.ReadWrite',
    'https://graph.microsoft.com/People.Read',
    'offline_access',
  ];
  const scopedToken = await graph.getAccessTokenForScopes(email, requestedScopes);
  const regularToken = scopedToken || await graph.getAccessToken(email);
  const regularSummary = regularToken ? summarizeGraphToken(regularToken) : null;
  const usingDelegatedToken = !!(regularSummary && regularSummary.tokenType === 'delegated');
  const graphToken = regularToken || await graph.getClientCredentialsToken(true);
  if (!graphToken) {
    lastContactsTrace.people = { requestedScopes, error: 'NOT_AUTHENTICATED_OR_SCOPE_REFRESH_FAILED' };
    throw new Error('NOT_AUTHENTICATED');
  }
  const sel = 'id,displayName,givenName,surname,scoredEmailAddresses,phones,companyName,jobTitle,userPrincipalName';
  const peopleEndpoint = usingDelegatedToken
    ? `${GRAPH_ROOT}/me/people`
    : `${GRAPH_ROOT}/users/${encodeURIComponent(email)}/people`;
  let url = `${peopleEndpoint}?$top=1000&$select=${encodeURIComponent(sel)}`;
  const rows = [];
  const previousPeopleTrace = lastContactsTrace.people || {};
  lastContactsTrace.people = {
    ...previousPeopleTrace,
    mailbox: email,
    requestedScopes,
    token: summarizeGraphToken(graphToken),
    authMode: usingDelegatedToken ? 'delegated' : 'application',
    requiredApplicationPermission: usingDelegatedToken ? null : 'People.Read.All',
    select: sel,
    endpoints: [],
  };
  contactsTraceLog('[Outlook People][TRACE] Requested scopes:', requestedScopes);
  contactsTraceLog('[Outlook People][TRACE] Token permission summary:', lastContactsTrace.people.token);
  tracePermissionDecision('people-api', lastContactsTrace.people.token, usingDelegatedToken ? ['People.Read'] : ['People.Read.All']);
  contactsTraceLog('[Outlook People][TRACE] People fields selected:', sel);
  for (let page = 0; page < 20 && url; page++) {
    const traceItem = { label: 'me-people', page, url, status: null, count: 0, next: false };
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${graphToken}`, 'Content-Type': 'application/json', ConsistencyLevel: 'eventual' },
    });
    traceItem.status = res.status;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      traceItem.error = err.error?.message || `Graph API error ${res.status}`;
      lastContactsTrace.people.endpoints.push(traceItem);
      contactsTraceWarn('[Outlook People][TRACE] Graph page failed:', traceItem);
      const graphErr = new Error(err.error?.message || `Graph API error ${res.status}`);
      graphErr.status = res.status;
      graphErr.code = err.error?.code;
      throw graphErr;
    }
    const data = await res.json();
    const pageRows = data.value || [];
    const mappedRows = pageRows.map(mapOutlookPersonToContact);
    rows.push(...mappedRows);
    url = data['@odata.nextLink'] || null;
    traceItem.count = pageRows.length;
    traceItem.withPhone = mappedRows.filter(c => contactPhoneSummary(c).hasAnyPhone).length;
    traceItem.next = !!url;
    lastContactsTrace.people.endpoints.push(traceItem);
    contactsTraceLog('[Outlook People][TRACE] Graph page:', traceItem);
    traceContactSample(`people-api:page-${page}`, mappedRows, 3);
  }
  lastContactsTrace.people.totalFetched = rows.length;
  lastContactsTrace.people.withPhone = rows.filter(p => p.mobilePhone || (p.businessPhones && p.businessPhones.length)).length;
  contactsTraceLog(`[Outlook People][TRACE] Total fetched: ${rows.length} | With phone: ${lastContactsTrace.people.withPhone}`);
  traceContactSample('people-api-final', rows, 12);
  return rows;
}

/** Derive CRM name from Graph contact (displayName is often empty; givenName/surname/email are reliable). */
function splitOutlookContactName(oc) {
  const primaryEmail = (oc.emailAddresses || []).map((e) => e.address).filter(Boolean)[0] || '';
  const given = (oc.givenName || '').trim();
  const surname = (oc.surname || '').trim();
  if (given || surname) {
    return { fname: given || 'Contact', lname: surname || '-' };
  }
  const displayName = (oc.displayName || '').trim();
  if (displayName) {
    const parts = displayName.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { fname: parts[0], lname: '-' };
    return { fname: parts[0], lname: parts.slice(1).join(' ') };
  }
  if (primaryEmail) {
    const local = (primaryEmail.split('@')[0] || 'contact').replace(/[._+]+/g, ' ');
    const parts = local.split(/\s+/).filter(Boolean);
    if (!parts.length) return { fname: 'Contact', lname: '-' };
    if (parts.length === 1) return { fname: parts[0], lname: '-' };
    return { fname: parts[0], lname: parts.slice(1).join(' ') };
  }
  return { fname: 'Contact', lname: '-' };
}

// ── OAuth callback — no JWT (browser redirect) ────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <html><body style="font-family:sans-serif;background:#0c0f1a;color:#e8ecf4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center;">
          <h2 style="color:#f87171;">Authentication Failed</h2>
          <p>${error_description || error}</p>
          <a href="${APP_PUBLIC_URL}/dashboard.html" style="color:#2796C4;">← Back to Dashboard</a>
        </div>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;background:#0c0f1a;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;">
        <div style="max-width:420px;text-align:center;">
          <h2 style="color:#2796C4;margin-top:0;">This page is not opened directly</h2>
          <p style="color:#8b9ab8;line-height:1.5;">Microsoft sends you here <strong>after</strong> you sign in, with <code style="background:#1a2035;padding:2px 6px;border-radius:4px;">?code=…</code> in the URL.</p>
          <p style="color:#6b7a99;font-size:14px;">Go to the dashboard, click <strong>Connect Outlook</strong>, complete login — you will land here automatically.</p>
          <p style="margin-top:24px;"><a href="${APP_PUBLIC_URL}/dashboard.html" style="color:#34d399;">Open dashboard</a></p>
        </div>
      </body></html>
    `);
  }

  try {
    const { email } = await graph.exchangeCode(code);
    return res.send(`
      <html><body style="font-family:sans-serif;background:#0c0f1a;color:#e8ecf4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center;">
          <div style="font-size:48px;margin-bottom:16px;">✅</div>
          <h2 style="color:#34d399;">Outlook Connected!</h2>
          <p style="color:#8b9ab8;">${email} is now linked to UniComm Pro.</p>
          <p style="color:#6b7a99;font-size:13px;margin-top:8px;">Redirecting to dashboard…</p>
        </div>
        <script>setTimeout(()=>window.location.href='${APP_PUBLIC_URL}/dashboard.html',2000)</script>
      </body></html>
    `);
  } catch (err) {
    console.error('[Outlook] OAuth callback error:', err.message);
    return res.status(500).send(`Authentication error: ${err.message}`);
  }
});

// All routes below require JWT
router.use(authenticate);

async function countBroadcastsForEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
       FROM email_broadcasts b
       WHERE b.status IN ('sent', 'sending')
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(b.recipients, '[]'::jsonb)) AS elem
         WHERE (
           (jsonb_typeof(elem) = 'string' AND lower(trim(both '"' from elem::text)) = $1)
           OR (jsonb_typeof(elem) = 'object' AND lower(trim(elem->>'email')) = $1)
         )
       )`,
      [e]
    );
    return r.rows[0].n;
  } catch (_) {
    return 0;
  }
}

/** Warmed by GET /api/outlook/contacts — speeds GET /directory-activity for the same mailbox */
let directoryStatsCache = { map: null, at: 0, mailbox: null };
const DIRECTORY_STATS_CACHE_MS = 120000;

// ── GET /api/outlook/status ───────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const authed = await graph.isAuthenticated(MS_EMAIL);
    return res.json({ connected: authed, email: MS_EMAIL });
  } catch (_) {
    return res.json({ connected: false, email: MS_EMAIL });
  }
});

// ── GET /api/outlook/auth ─────────────────────────────────────────────────
router.get('/auth', async (req, res) => {
  try {
    console.log('[Outlook] GET /api/outlook/auth from', req.ip, req.get('user-agent')?.slice(0, 60));
    const url = await graph.getAuthUrl('unicomm-dashboard');
    return res.json({ url });
  } catch (err) {
    console.error('[Outlook] Auth URL error:', err.message);
    return res.json({
      url: null,
      error: err.message,
      configured: false,
      redirectUri: typeof graph.getRedirectUri === 'function' ? graph.getRedirectUri() : null,
    });
  }
});

// ── GET /api/outlook/inbox ────────────────────────────────────────────────
router.get('/inbox', async (req, res) => {
  const filter = req.query.filter || '';
  const top    = parseInt(req.query.top  || '50');
  const skip   = parseInt(req.query.skip || '0');

  console.log('[Outlook] GET /inbox — top:', top, 'skip:', skip, 'filter:', JSON.stringify(filter));

  let endpoint;

  if (filter) {
    // Use Graph $search for full mailbox search (server-side, searches all emails)
    // NOTE: $search cannot be combined with $orderby — results come in relevance order
    const kql = filter.trim();
    endpoint = `/me/mailFolders/inbox/messages?$top=${top}`
      + `&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,importance`
      + `&$search="${encodeURIComponent(kql)}"`;
    console.log('[Outlook] Using Graph $search (server-side, full mailbox):', kql);
  } else {
    // Normal inbox fetch with chronological order
    endpoint = `/me/mailFolders/inbox/messages?$top=${top}&$skip=${skip}`
      + `&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,importance`
      + `&$orderby=receivedDateTime desc`;
  }

  console.log('[Outlook] Graph endpoint:', endpoint);

  try {
    console.log('[Outlook] Calling graph.graphGet...');
    const data = await graph.graphGet(endpoint, MS_EMAIL);
    console.log('[Outlook] Graph response received — message count:', (data.value || []).length);

    const messages = data.value || [];
    console.log('[Outlook] Returning', messages.length, 'messages');

    // Store messages in database for fallback
    if (messages.length > 0) {
      try {
        await storeMessagesInDB(messages, 'inbox');
        console.log('[Outlook] ✓ Stored', messages.length, 'messages in DB');
      } catch (dbErr) {
        console.warn('[Outlook] Failed to store messages in DB:', dbErr.message);
      }
    }

    return res.json({
      messages,
      nextLink: data['@odata.nextLink'] || null,
      total:    messages.length,
      source: 'api'
    });
  } catch (err) {
    console.error('[Outlook] ❌ Inbox fetch error:', err.message);
    console.error('[Outlook] Error stack:', err.stack);
    if (err.message === 'NOT_AUTHENTICATED') {
      return res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Outlook not connected. Please authenticate.' });
    }
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ── GET /api/outlook/inbox/fallback ──────────────────────────────────────
// Fallback endpoint to load emails from database when API fails
router.get('/inbox/fallback', async (req, res) => {
  const top = parseInt(req.query.top || '50');
  const skip = parseInt(req.query.skip || '0');

  console.log('[Outlook] GET /inbox/fallback — loading from DB, top:', top, 'skip:', skip);

  try {
    await mailStore.ensureTable();

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outlook_emails_cache (
        id                TEXT PRIMARY KEY,
        conversation_id   TEXT,
        subject           TEXT,
        from_address      TEXT,
        from_name         TEXT,
        to_recipients     JSONB,
        cc_recipients     JSONB,
        received_datetime TIMESTAMPTZ,
        sent_datetime     TIMESTAMPTZ,
        is_read           BOOLEAN DEFAULT FALSE,
        body_preview      TEXT,
        has_attachments   BOOLEAN DEFAULT FALSE,
        importance        TEXT,
        folder            TEXT DEFAULT 'inbox',
        category          TEXT DEFAULT 'GENERAL',
        synced_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const result = await pool.query(`
      SELECT
        id,
        conversation_id AS "conversationId",
        subject,
        from_address,
        from_name,
        to_recipients,
        cc_recipients,
        received_datetime,
        sent_datetime,
        is_read,
        body_preview,
        has_attachments,
        importance,
        category
      FROM outlook_emails_cache
      WHERE folder = 'inbox'
      ORDER BY received_datetime DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [top, skip]);

    // Transform to match API format
    const messages = result.rows.map(row => ({
      id: row.id,
      conversationId: row.conversationId,
      subject: row.subject,
      from: {
        emailAddress: {
          address: row.from_address,
          name: row.from_name
        }
      },
      toRecipients: row.to_recipients || [],
      ccRecipients: row.cc_recipients || [],
      receivedDateTime: row.received_datetime,
      sentDateTime: row.sent_datetime,
      isRead: row.is_read,
      bodyPreview: row.body_preview,
      hasAttachments: row.has_attachments,
      importance: row.importance,
      category: row.category || 'GENERAL'
    }));

    console.log('[Outlook] Fallback: Loaded', messages.length, 'messages from DB');

    return res.json({
      messages,
      nextLink: null,
      total: messages.length,
      source: 'database'
    });
  } catch (err) {
    console.error('[Outlook] ❌ Fallback error:', err.message);
    return res.status(500).json({ error: err.message, messages: [] });
  }
});

// ── GET /api/outlook/categorize ──────────────────────────────────────────
router.get('/categorize', async (req, res) => {
  const top = parseInt(req.query.top || '50');

  console.log('[Outlook] GET /categorize — fetching', top, 'emails for categorization');

  try {
    // Fetch emails from Graph API
    const endpoint = `/me/mailFolders/inbox/messages?$top=${top}`
      + `&$select=id,subject,from,bodyPreview,receivedDateTime,isRead,hasAttachments,importance,categories`
      + `&$orderby=receivedDateTime desc`;

    const data = await graph.graphGet(endpoint, MS_EMAIL);
    const messages = data.value || [];

    console.log('[Outlook] Fetched', messages.length, 'emails for categorization');

    // Transform to categorization format
    const emails = messages.map(msg => ({
      id: msg.id,
      subject: msg.subject || '(no subject)',
      from: msg.from?.emailAddress?.address || '',
      fromName: msg.from?.emailAddress?.name || '',
      body_summary: (msg.bodyPreview || '').substring(0, 200),
      received_time: msg.receivedDateTime,
      is_read: msg.isRead || false,
      has_attachments: msg.hasAttachments || false,
      importance: msg.importance || 'normal',
      existing_categories: msg.categories || []
    }));

    // Categorization logic
    const categorized = emails.map(email => {
      const subject = (email.subject || '').toLowerCase();
      const body = (email.body_summary || '').toLowerCase();
      const from = (email.from || '').toLowerCase();
      const combined = `${subject} ${body} ${from}`;

      const now = new Date();
      const receivedDate = new Date(email.received_time);
      const hoursSinceReceived = (now - receivedDate) / (1000 * 60 * 60);
      const isRecent = hoursSinceReceived <= 48;

      let category = 'GENERAL';
      let priority = 'LOW';
      let reason = 'Default category';

      // Priority order: LEAD > IMPORTANT > NEEDS_REPLY > ATTACHMENT > UNREAD > GENERAL

      // Check for LEAD / SALES
      const leadKeywords = ['indiamart', 'buyer', 'enquiry', 'inquiry', 'quotation', 'quote request', 'product inquiry', 'business opportunity', 'interested in', 'purchase', 'order'];
      if (leadKeywords.some(kw => combined.includes(kw))) {
        category = 'LEAD';
        priority = 'HIGH';
        reason = 'Detected buyer inquiry or sales opportunity keywords';
      }

      // Check for IMPORTANT
      else if (email.importance === 'high' || ['urgent', 'asap', 'important', 'critical', 'immediate'].some(kw => combined.includes(kw))) {
        category = 'IMPORTANT';
        priority = 'HIGH';
        reason = 'Marked as high importance or contains urgency keywords';
      }

      // Check for NEEDS_REPLY
      else if (['quote', 'price', 'pricing', 'need', 'requirement', 'please respond', 'please reply', 'waiting for', 'can you', 'could you', 'would you'].some(kw => combined.includes(kw))) {
        category = 'NEEDS_REPLY';
        priority = 'MEDIUM';
        reason = 'Contains keywords indicating response required';
      }

      // Check for SYSTEM / OTP
      else if (['otp', 'verification code', 'login alert', 'security code', 'authentication', 'verify your', 'no-reply', 'noreply', 'automated'].some(kw => combined.includes(kw))) {
        category = 'SYSTEM';
        priority = 'LOW';
        reason = 'Automated system message or OTP';
      }

      // Check for ATTACHMENT
      else if (email.has_attachments) {
        category = 'ATTACHMENT';
        priority = 'MEDIUM';
        reason = 'Email contains attachments';
      }

      // Check for UNREAD
      else if (!email.is_read) {
        category = 'UNREAD';
        priority = 'MEDIUM';
        reason = 'Email is unread';
      }

      // Boost priority if recent
      if (isRecent && priority === 'LOW') {
        priority = 'MEDIUM';
      }
      if (isRecent && category === 'LEAD') {
        priority = 'URGENT';
      }

      return {
        id: email.id,
        subject: email.subject,
        from: email.from,
        fromName: email.fromName,
        category,
        priority,
        reason,
        received_time: email.received_time,
        is_read: email.is_read,
        has_attachments: email.has_attachments
      };
    });

    console.log('[Outlook] Categorized', categorized.length, 'emails');

    // Return categorized results
    return res.json({
      total: categorized.length,
      categorized,
      summary: {
        LEAD: categorized.filter(e => e.category === 'LEAD').length,
        IMPORTANT: categorized.filter(e => e.category === 'IMPORTANT').length,
        NEEDS_REPLY: categorized.filter(e => e.category === 'NEEDS_REPLY').length,
        SYSTEM: categorized.filter(e => e.category === 'SYSTEM').length,
        ATTACHMENT: categorized.filter(e => e.category === 'ATTACHMENT').length,
        UNREAD: categorized.filter(e => e.category === 'UNREAD').length,
        GENERAL: categorized.filter(e => e.category === 'GENERAL').length,
      }
    });

  } catch (err) {
    console.error('[Outlook] ❌ Categorization error:', err.message);
    if (err.message === 'NOT_AUTHENTICATED') {
      return res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Outlook not connected. Please authenticate.' });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/thread ─────────────────────────────────────────────
router.get('/thread', async (req, res) => {
  const cid = req.query.conversationId;
  if (!cid || typeof cid !== 'string') {
    return res.status(400).json({ error: 'conversationId query parameter is required' });
  }
  const escaped = cid.replace(/'/g, "''");
  const filter = encodeURIComponent(`conversationId eq '${escaped}'`);
  try {
    // Use /me/messages which searches ALL folders (inbox + sent + drafts)
    // NOTE: $filter and $orderby cannot be combined in Graph API — sort client-side
    const data = await graph.graphGet(
      `/me/messages?$filter=${filter}&$top=50`
      + `&$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,sentDateTime`,
      MS_EMAIL
    );
    // Sort by date ascending (oldest first) client-side
    // Deduplicate by message ID (same message can appear in inbox + sent folders)
    const seen = new Set();
    const messages = (data.value || [])
      .filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
      .sort((a, b) => {
        const ta = new Date(a.receivedDateTime || a.sentDateTime || 0).getTime();
        const tb = new Date(b.receivedDateTime || b.sentDateTime || 0).getTime();
        return ta - tb;
      });
    return res.json({ messages });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/message/:messageId/attachment/:attachmentId/raw ─────
router.get('/message/:messageId/attachment/:attachmentId/raw', async (req, res) => {
  try {
    const token = await graph.getAccessToken(MS_EMAIL);
    const mid = encodeURIComponent(parseOutlookMessageId(req.params.messageId));
    const aid = encodeURIComponent(parseOutlookMessageId(req.params.attachmentId));
    const url = `https://graph.microsoft.com/v1.0/me/messages/${mid}/attachments/${aid}/$value`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(r.status).send(txt || 'Attachment not found');
    }
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=600');
    return res.send(buf);
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

const OUTLOOK_MESSAGE_SELECT = [
  'id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'sentDateTime', 'createdDateTime',
  'body', 'uniqueBody', 'isRead', 'hasAttachments', 'importance', 'conversationId', 'webLink', 'isDraft',
].join(',');

function parseOutlookMessageId(raw) {
  if (raw == null || raw === '') return '';
  let id = String(raw).trim();
  try {
    let decoded = decodeURIComponent(id);
    while (decoded !== id) {
      id = decoded;
      decoded = decodeURIComponent(id);
    }
  } catch (_) { /* keep id */ }
  return id;
}

function isGraphMessageNotFound(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  const msg = String(err.message || '');
  const code = String(err.code || '');
  return /not found/i.test(msg)
    || /ErrorItemNotFound/i.test(code)
    || /ErrorInvalidIdMalformed/i.test(code);
}

/** List attachments for a message (metadata only; bytes via /attachment/:aid/raw). */
async function fetchMessageAttachments(messageId) {
  const id = parseOutlookMessageId(messageId);
  const mid = encodeURIComponent(id);
  const paths = [
    `/me/messages/${mid}/attachments?$top=100`,
    `/me/mailFolders/drafts/messages/${mid}/attachments?$top=100`,
    `/me/mailFolders/sentitems/messages/${mid}/attachments?$top=100`,
    `/me/mailFolders/inbox/messages/${mid}/attachments?$top=100`,
  ];
  let lastErr;
  for (const path of paths) {
    try {
      const attData = await graph.graphGet(path, MS_EMAIL);
      return attData.value || [];
    } catch (err) {
      lastErr = err;
      if (!isGraphMessageNotFound(err)) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

async function fetchOutlookMessageFromGraph(messageId) {
  const id = parseOutlookMessageId(messageId);
  if (!id) throw new Error('Message id is required');
  const mid = encodeURIComponent(id);
  const q = `$select=${encodeURIComponent(OUTLOOK_MESSAGE_SELECT)}`;
  const paths = [
    `/me/messages/${mid}?${q}`,
    `/me/mailFolders/drafts/messages/${mid}?${q}`,
    `/me/mailFolders/sentitems/messages/${mid}?${q}`,
    `/me/mailFolders/inbox/messages/${mid}?${q}`,
    `/me/mailFolders/deleteditems/messages/${mid}?${q}`,
  ];
  let lastErr;
  for (const path of paths) {
    try {
      return await graph.graphGet(path, MS_EMAIL);
    } catch (err) {
      lastErr = err;
      if (!isGraphMessageNotFound(err)) throw err;
    }
  }
  throw lastErr || new Error('Message not found');
}

async function fetchCachedOutlookMessageRow(messageId) {
  const id = parseOutlookMessageId(messageId);
  if (!id) return null;
  const result = await pool.query(`
    SELECT id, conversation_id, subject, from_address, from_name,
           to_recipients, cc_recipients, received_datetime, sent_datetime,
           is_read, body_preview, has_attachments, importance, folder
    FROM outlook_emails_cache
    WHERE id = $1
    LIMIT 1
  `, [id]);
  return result.rows[0] || null;
}

function cachedRowToMessagePayload(row, warning) {
  const preview = row.body_preview || '';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    subject: row.subject || '',
    from: { emailAddress: { address: row.from_address || '', name: row.from_name || '' } },
    toRecipients: row.to_recipients || [],
    ccRecipients: row.cc_recipients || [],
    receivedDateTime: row.received_datetime,
    sentDateTime: row.sent_datetime,
    isRead: row.is_read,
    hasAttachments: row.has_attachments,
    importance: row.importance || 'normal',
    isDraft: row.folder === 'drafts',
    bodyPreview: preview,
    body: { contentType: 'text', content: preview },
    uniqueBody: { contentType: 'text', content: preview },
    partial: true,
    loadWarning: warning || null,
  };
}

// ── GET /api/outlook/message/:id ──────────────────────────────────────────
router.get('/message/:id', async (req, res) => {
  try {
    const messageId = parseOutlookMessageId(req.params.id);
    if (!messageId) return res.status(400).json({ error: 'Message id is required' });

    let data;
    let graphErr = null;
    try {
      data = await fetchOutlookMessageFromGraph(messageId);
    } catch (err) {
      graphErr = err;
      const row = await fetchCachedOutlookMessageRow(messageId);
      if (!row) throw err;
      console.warn('[Outlook] Graph message load failed, using cache:', err.message);
      data = cachedRowToMessagePayload(row, err.message);
    }

    if (data.hasAttachments && !data.partial) {
      try {
        data.attachments = await fetchMessageAttachments(messageId);
      } catch (attErr) {
        console.warn('[Outlook] Attachment list failed:', attErr.message);
        data.attachments = [];
      }
    }

    if (!data.partial && !data.isDraft) {
      const mid = encodeURIComponent(messageId);
      graph.graphPatch(`/me/messages/${mid}`, { isRead: true }, MS_EMAIL).catch(() => {});
    }

    return res.json(data);
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    const status = isGraphMessageNotFound(err) ? 404 : (err.status || 500);
    return res.status(status).json({ error: err.message });
  }
});

// ── GET /api/outlook/message/:id/attachments ─────────────────────────────
router.get('/message/:id/attachments', async (req, res) => {
  try {
    const attachments = await fetchMessageAttachments(req.params.id);
    return res.json({ attachments });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

async function refreshSentItemsCache(top = 15) {
  const data = await graph.graphGet(
    `/me/mailFolders/sentitems/messages?$top=${top}&$skip=0`
    + `&$select=id,conversationId,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,createdDateTime,bodyPreview,hasAttachments,isRead`
    + `&$orderby=sentDateTime desc`,
    MS_EMAIL
  );
  const messages = data.value || [];
  if (messages.length) {
    await storeMessagesInDB(messages, 'sent');
  }
  return messages;
}

// ── GET /api/outlook/sent ─────────────────────────────────────────────────
router.get('/sent', async (req, res) => {
  const top  = parseInt(req.query.top  || '25');
  const skip = parseInt(req.query.skip || '0');
  const search = String(req.query.search || req.query.filter || '').trim();
  try {
    const sel = 'id,conversationId,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,createdDateTime,bodyPreview,hasAttachments,isRead';
    let path = `/me/mailFolders/sentitems/messages?$top=${top}&$skip=${skip}`
      + `&$select=${sel}`
      + `&$orderby=sentDateTime desc`;
    let data;
    if (search) {
      const escaped = search.replace(/'/g, "''");
      const filteredPath = path + `&$filter=contains(subject,'${escaped}') or contains(bodyPreview,'${escaped}')`;
      try {
        data = await graph.graphGet(filteredPath, MS_EMAIL);
      } catch (filterErr) {
        console.warn('[Outlook] Sent search filter failed, loading page without filter:', filterErr.message);
        data = await graph.graphGet(path, MS_EMAIL);
      }
    } else {
      data = await graph.graphGet(path, MS_EMAIL);
    }

    let messages = data.value || [];
    if (search) {
      const q = search.toLowerCase();
      messages = messages.filter(m => {
        const subj = String(m.subject || '').toLowerCase();
        const prev = String(m.bodyPreview || '').toLowerCase();
        const toStr = (m.toRecipients || []).map(r => String(r?.emailAddress?.address || '').toLowerCase()).join(' ');
        return subj.includes(q) || prev.includes(q) || toStr.includes(q);
      });
    }

    // Store messages in database for fallback
    if (messages.length > 0) {
      try {
        await storeMessagesInDB(messages, 'sent');
        console.log('[Outlook] ✓ Stored', messages.length, 'sent messages in DB');
      } catch (dbErr) {
        console.warn('[Outlook] Failed to store sent messages in DB:', dbErr.message);
      }
    }

    return res.json({ messages, source: 'api' });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/sent/fallback ───────────────────────────────────────
router.get('/sent/fallback', async (req, res) => {
  const top = parseInt(req.query.top || '25');
  const skip = parseInt(req.query.skip || '0');

  console.log('[Outlook] GET /sent/fallback — loading from DB');

  try {
    const search = String(req.query.search || req.query.filter || '').trim().toLowerCase();
    const result = await pool.query(`
      SELECT
        id,
        conversation_id AS "conversationId",
        subject,
        from_address,
        from_name,
        to_recipients,
        cc_recipients,
        sent_datetime,
        received_datetime,
        body_preview,
        has_attachments,
        is_read
      FROM outlook_emails_cache
      WHERE folder = 'sent'
      ORDER BY sent_datetime DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [top, skip]);

    let messages = result.rows.map(row => ({
      id: row.id,
      conversationId: row.conversationId,
      subject: row.subject,
      from: row.from_address ? { emailAddress: { address: row.from_address, name: row.from_name || row.from_address } } : undefined,
      toRecipients: row.to_recipients || [],
      ccRecipients: row.cc_recipients || [],
      sentDateTime: row.sent_datetime,
      receivedDateTime: row.received_datetime,
      bodyPreview: row.body_preview,
      hasAttachments: row.has_attachments,
      isRead: row.is_read
    }));

    if (search) {
      messages = messages.filter(m => {
        const subj = String(m.subject || '').toLowerCase();
        const prev = String(m.bodyPreview || '').toLowerCase();
        const toStr = (m.toRecipients || []).map(r => {
          const a = r?.emailAddress?.address || r?.address || (typeof r === 'string' ? r : '');
          return String(a).toLowerCase();
        }).join(' ');
        return subj.includes(search) || prev.includes(search) || toStr.includes(search);
      });
    }

    console.log('[Outlook] Fallback: Loaded', messages.length, 'sent messages from DB');

    return res.json({ messages, source: 'database' });
  } catch (err) {
    console.error('[Outlook] ❌ Sent fallback error:', err.message);
    return res.status(500).json({ error: err.message, messages: [] });
  }
});

// ── GET /api/outlook/drafts ──────────────────────────────────────────────
router.get('/drafts', async (req, res) => {
  const top = parseInt(req.query.top || '25');
  const skip = parseInt(req.query.skip || '0');

  console.log('[Outlook] GET /drafts — top:', top, 'skip:', skip);

  try {
    const data = await graph.graphGet(
      `/me/mailFolders/drafts/messages?$top=${top}&$skip=${skip}`
      + `&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,createdDateTime,isRead,bodyPreview,hasAttachments,importance,isDraft`
      + `&$orderby=createdDateTime desc`,
      MS_EMAIL
    );

    const messages = data.value || [];

    // Store messages in database for fallback
    if (messages.length > 0) {
      try {
        await storeMessagesInDB(messages, 'drafts');
        console.log('[Outlook] ✓ Stored', messages.length, 'draft messages in DB');
      } catch (dbErr) {
        console.warn('[Outlook] Failed to store draft messages in DB:', dbErr.message);
      }
    }

    console.log('[Outlook] Returning', messages.length, 'draft messages');
    return res.json({ messages, source: 'api' });
  } catch (err) {
    console.error('[Outlook] ❌ Drafts fetch error:', err.message);
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/drafts/fallback ─────────────────────────────────────
router.get('/drafts/fallback', async (req, res) => {
  const top = parseInt(req.query.top || '25');
  const skip = parseInt(req.query.skip || '0');

  console.log('[Outlook] GET /drafts/fallback — loading from DB');

  try {
    const result = await pool.query(`
      SELECT
        id,
        conversation_id AS "conversationId",
        subject,
        from_address,
        from_name,
        to_recipients,
        cc_recipients,
        received_datetime,
        sent_datetime,
        is_read,
        body_preview,
        has_attachments,
        importance
      FROM outlook_emails_cache
      WHERE folder = 'drafts'
      ORDER BY received_datetime DESC NULLS LAST, sent_datetime DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [top, skip]);

    const messages = result.rows.map(row => ({
      id: row.id,
      conversationId: row.conversationId,
      subject: row.subject,
      from: {
        emailAddress: {
          address: row.from_address,
          name: row.from_name
        }
      },
      toRecipients: row.to_recipients || [],
      ccRecipients: row.cc_recipients || [],
      receivedDateTime: row.received_datetime,
      sentDateTime: row.sent_datetime,
      isRead: row.is_read,
      bodyPreview: row.body_preview,
      hasAttachments: row.has_attachments,
      importance: row.importance,
      isDraft: true
    }));

    console.log('[Outlook] Fallback: Loaded', messages.length, 'draft messages from DB');
    return res.json({ messages, source: 'database' });
  } catch (err) {
    console.error('[Outlook] ❌ Drafts fallback error:', err.message);
    return res.status(500).json({ error: err.message, messages: [] });
  }
});

// ── POST /api/outlook/drafts ─────────────────────────────────────────────
// Create a draft message in Outlook Drafts folder via Microsoft Graph API
router.post('/drafts', async (req, res) => {
  const { to, subject, body, cc, attachments } = req.body;

  console.log('[Outlook] POST /drafts — subject:', subject, '| body length:', (body||'').length);

  const toRecipients = normalizeMailRecipients(to).map(addr => ({ emailAddress: { address: addr } }));
  const ccRecipients = normalizeMailRecipients(cc).map(addr => ({ emailAddress: { address: addr } }));
  const graphAttachments = buildGraphFileAttachments(attachments);

  const message = {
    subject: subject || '(No subject)',
    body: { contentType: 'HTML', content: body || '' },
    ...(toRecipients.length ? { toRecipients } : {}),
    ...(ccRecipients.length ? { ccRecipients } : {}),
  };

  try {
    // POST to /me/messages creates a draft in the Drafts folder
    const draft = await graph.graphPost('/me/messages', message, MS_EMAIL);
    if (graphAttachments.length) {
      await addAttachmentsToMessage(draft.id, graphAttachments);
    }
    console.log('[Outlook] ✓ Draft created, id:', draft.id);
    return res.json({ success: true, draftId: draft.id, attachments: graphAttachments.length });
  } catch (err) {
    console.error('[Outlook] ❌ Create draft error:', err.message);
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/deleted ─────────────────────────────────────────────
router.get('/deleted', async (req, res) => {
  const top = parseInt(req.query.top || '25');
  const skip = parseInt(req.query.skip || '0');

  console.log('[Outlook] GET /deleted — top:', top, 'skip:', skip);

  try {
    const data = await graph.graphGet(
      `/me/mailFolders/deleteditems/messages?$top=${top}&$skip=${skip}`
      + `&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,bodyPreview,hasAttachments,importance`
      + `&$orderby=receivedDateTime desc`,
      MS_EMAIL
    );

    const messages = data.value || [];

    // Store messages in database for fallback
    if (messages.length > 0) {
      try {
        await storeMessagesInDB(messages, 'deleted'); // Standardized tag
        console.log('[Outlook] ✓ Stored', messages.length, 'deleted messages in DB');
      } catch (dbErr) {
        console.warn('[Outlook] Failed to store deleted messages in DB:', dbErr.message);
      }
    }

    console.log('[Outlook] Returning', messages.length, 'deleted messages');
    return res.json({ messages, source: 'api' });
  } catch (err) {
    console.error('[Outlook] ❌ Deleted items fetch error:', err.message);
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/deleted/fallback ────────────────────────────────────
router.get('/deleted/fallback', async (req, res) => {
  const top = parseInt(req.query.top || '25');
  const skip = parseInt(req.query.skip || '0');

  console.log('[Outlook] GET /deleted/fallback — loading from DB');

  try {
    const result = await pool.query(`
      SELECT
        id,
        conversation_id AS "conversationId",
        subject,
        from_address,
        from_name,
        to_recipients,
        cc_recipients,
        received_datetime,
        sent_datetime,
        is_read,
        body_preview,
        has_attachments,
        importance
      FROM outlook_emails_cache
      WHERE folder = 'deleted'
      ORDER BY received_datetime DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [top, skip]);

    const messages = result.rows.map(row => ({
      id: row.id,
      conversationId: row.conversationId,
      subject: row.subject,
      from: {
        emailAddress: {
          address: row.from_address,
          name: row.from_name
        }
      },
      toRecipients: row.to_recipients || [],
      ccRecipients: row.cc_recipients || [],
      receivedDateTime: row.received_datetime,
      sentDateTime: row.sent_datetime,
      isRead: row.is_read,
      bodyPreview: row.body_preview,
      hasAttachments: row.has_attachments,
      importance: row.importance
    }));

    console.log('[Outlook] Fallback: Loaded', messages.length, 'deleted messages from DB');
    return res.json({ messages, source: 'database' });
  } catch (err) {
    console.error('[Outlook] ❌ Deleted fallback error:', err.message);
    return res.status(500).json({ error: err.message, messages: [] });
  }
});

// ── GET /api/outlook/folder/:folderName ─────────────────────────────────
// Generic endpoint for Junk, Notes, Archive, or custom folders
router.get('/folder/:folderName', async (req, res) => {
  const folder = req.params.folderName;
  const top = parseInt(req.query.top || '25');
  const skip = parseInt(req.query.skip || '0');

  console.log(`[Outlook] GET /folder/${folder} — top:`, top, 'skip:', skip);

  try {
    const folderSegment = encodeURIComponent(folder);
    const data = await graph.graphGet(
      `/me/mailFolders/${folderSegment}/messages?$top=${top}&$skip=${skip}`
      + `&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,bodyPreview,hasAttachments,importance`
      + `&$orderby=receivedDateTime desc`,
      MS_EMAIL
    );

    const messages = data.value || [];

    // Store in DB for fallback
    if (messages.length > 0) {
      try {
        await storeMessagesInDB(messages, folder);
      } catch (dbErr) {
        console.warn(`[Outlook] Failed to store ${folder} messages in DB:`, dbErr.message);
      }
    }

    return res.json({ messages, source: 'api' });
  } catch (err) {
    console.error(`[Outlook] ❌ Folder ${folder} fetch error:`, err.message);
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/folder/:folderName/fallback ─────────────────────────
router.get('/folder/:folderName/fallback', async (req, res) => {
  const folder = req.params.folderName;
  const top = parseInt(req.query.top || '25');
  const skip = parseInt(req.query.skip || '0');

  try {
    const result = await pool.query(`
      SELECT
        id,
        conversation_id AS "conversationId",
        subject,
        from_address,
        from_name,
        to_recipients,
        cc_recipients,
        received_datetime,
        sent_datetime,
        is_read,
        body_preview,
        has_attachments,
        importance,
        category
      FROM outlook_emails_cache
      WHERE folder = $1
      ORDER BY received_datetime DESC NULLS LAST, sent_datetime DESC NULLS LAST, synced_at DESC
      LIMIT $2 OFFSET $3
    `, [folder, top, skip]);

    const messages = result.rows.map(row => ({
      id: row.id,
      conversationId: row.conversationId,
      subject: row.subject,
      from: {
        emailAddress: {
          address: row.from_address,
          name: row.from_name
        }
      },
      toRecipients: row.to_recipients || [],
      ccRecipients: row.cc_recipients || [],
      receivedDateTime: row.received_datetime,
      sentDateTime: row.sent_datetime,
      isRead: row.is_read,
      bodyPreview: row.body_preview,
      hasAttachments: row.has_attachments,
      importance: row.importance,
      category: row.category || 'GENERAL'
    }));

    return res.json({ messages, source: 'database' });
  } catch (err) {
    console.error(`[Outlook] ❌ Folder ${folder} fallback error:`, err.message);
    return res.status(500).json({ error: err.message, messages: [] });
  }
});

// ── POST /api/outlook/update-category ────────────────────────────────────
router.post('/update-category', async (req, res) => {
  const { id, category } = req.body;
  if (!id || !category) return res.status(400).json({ error: 'ID and category required' });

  try {
    await pool.query(`
      UPDATE outlook_emails_cache
      SET category = $1
      WHERE id = $2
    `, [category, id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Outlook] Failed to update category in DB:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/folders ──────────────────────────────────────────────
router.get('/folders', async (req, res) => {
  try {
    console.log('[Outlook] Fetching folder metadata (Stable Mode)...');
    const data = await graph.graphGet(
      '/me/mailFolders?$top=100&$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount',
      MS_EMAIL
    );

    if (!data || !data.value) {
      return res.json([]);
    }

    return res.json(data.value);
  } catch (err) {
    console.error('[Outlook] ❌ Folders fetch error:', err.message);
    if (err.message === 'NOT_AUTHENTICATED') {
      const cachedFolders = await getCachedFolderStats().catch((cacheErr) => {
        console.warn('[Outlook] Folder cache fallback failed:', cacheErr.message);
        return [];
      });
      res.set('X-Outlook-Fallback', 'cache');
      return res.json(cachedFolders);
    }
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outlook/send ────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  const { to, subject, body, cc, importance, attachments } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject, and body are required.' });
  }

  const normalizedTo = normalizeMailRecipients(to);
  const normalizedCc = normalizeMailRecipients(cc);
  if (!normalizedTo.length) {
    return res.status(400).json({ error: 'At least one valid recipient is required.' });
  }

  const toRecipients = normalizedTo.map(addr => ({
    emailAddress: { address: addr }
  }));
  const ccRecipients = normalizedCc.map(addr => ({ emailAddress: { address: addr } }));
  const graphAttachments = buildGraphFileAttachments(attachments);

  const message = {
    subject,
    importance: importance || 'normal',
    body:       { contentType: 'HTML', content: body },
    toRecipients,
    ...(ccRecipients.length ? { ccRecipients } : {}),
  };

  try {
    if (graphAttachments.length) {
      await sendDraftMessage(message, graphAttachments);
    } else {
      await graph.graphPost('/me/sendMail', { message, saveToSentItems: true }, MS_EMAIL);
    }

    // Audit log
    pool.query(
      `INSERT INTO audit_log (user_id,action,entity,detail) VALUES ($1,$2,$3,$4)`,
      [req.user.id, 'EMAIL_SENT', 'outlook', `To: ${normalizedTo.join(',')} | Subject: ${subject}`]
    ).catch(() => {});

    // Activity log
    try {
      activityLog.append({ type: 'info', service: 'outlook', message: `Email sent to ${Array.isArray(to)?to.join(', '):to} — "${subject}"`, timestamp: new Date().toISOString() });
    } catch(_) {}

    clearStorageScanCache();
    // Pull latest sent items into local cache so UniComm list updates immediately
    try {
      await refreshSentItemsCache(20);
    } catch (cacheErr) {
      console.warn('[Outlook] Post-send sent cache refresh failed:', cacheErr.message);
    }
    return res.json({ success: true, message: 'Email sent successfully.' });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outlook/reply/:id ───────────────────────────────────────────
router.post('/reply/:id', async (req, res) => {
  const { body, replyAll, attachments } = req.body;
  if (!body) return res.status(400).json({ error: 'Reply body is required.' });
  const graphAttachments = buildGraphFileAttachments(attachments);

  const endpoint = replyAll
    ? `/me/messages/${req.params.id}/replyAll`
    : `/me/messages/${req.params.id}/reply`;

  try {
    if (graphAttachments.length) {
      const draftEndpoint = replyAll
        ? `/me/messages/${encodeURIComponent(req.params.id)}/createReplyAll`
        : `/me/messages/${encodeURIComponent(req.params.id)}/createReply`;
      const draft = await graph.graphPost(draftEndpoint, {}, MS_EMAIL);
      if (!draft || !draft.id) throw new Error('Could not create Outlook reply draft for attachments.');
      await graph.graphPatch(`/me/messages/${encodeURIComponent(draft.id)}`, {
        body: { contentType: 'HTML', content: body }
      }, MS_EMAIL);
      await addAttachmentsToMessage(draft.id, graphAttachments);
      await graph.graphPost(`/me/messages/${encodeURIComponent(draft.id)}/send`, {}, MS_EMAIL);
      clearStorageScanCache();
      try { await refreshSentItemsCache(20); } catch (_) { }
      return res.json({ success: true, attachments: graphAttachments.length });
    }

    await graph.graphPost(endpoint, {
      message: { body: { contentType: 'HTML', content: body } },
    }, MS_EMAIL);
    clearStorageScanCache();
    try { await refreshSentItemsCache(20); } catch (_) { }
    return res.json({ success: true });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/outlook/message/:id ───────────────────────────────────────
// Body: { isRead, categories, flag }
router.patch('/message/:id', async (req, res) => {
  const { isRead, categories, flag } = req.body;
  const patch = {};
  if (isRead !== undefined) patch.isRead = isRead;
  if (categories)           patch.categories = categories;
  if (flag)                 patch.flag = flag;

  try {
    const data = await graph.graphPatch(`/me/messages/${req.params.id}`, patch, MS_EMAIL);
    return res.json(data);
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/directory-activity?email= ─────────────────────────────
router.post('/message/:id/move', async (req, res) => {
  const destinationId = String(req.body?.destinationId || '').trim();
  if (!destinationId) return res.status(400).json({ error: 'destinationId is required' });
  try {
    const data = await graph.graphPost(
      `/me/messages/${encodeURIComponent(req.params.id)}/move`,
      { destinationId },
      MS_EMAIL
    );
    clearStorageScanCache();
    return res.json(data || { success: true });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

router.post('/message/:id/copy', async (req, res) => {
  const destinationId = String(req.body?.destinationId || '').trim();
  if (!destinationId) return res.status(400).json({ error: 'destinationId is required' });
  try {
    const data = await graph.graphPost(
      `/me/messages/${encodeURIComponent(req.params.id)}/copy`,
      { destinationId },
      MS_EMAIL
    );
    clearStorageScanCache();
    return res.json(data || { success: true });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/message/:id/unread', async (req, res) => {
  try {
    const data = await graph.graphPatch(`/me/messages/${encodeURIComponent(req.params.id)}`, { isRead: false }, MS_EMAIL);
    clearStorageScanCache();
    return res.json(data || { success: true });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/message/:id', async (req, res) => {
  try {
    try {
      await graph.graphPost(`/me/messages/${encodeURIComponent(req.params.id)}/permanentDelete`, {}, MS_EMAIL);
    } catch (_) {
      await graph.graphDelete(`/me/messages/${encodeURIComponent(req.params.id)}`, MS_EMAIL);
    }
    await pool.query(`DELETE FROM outlook_emails_cache WHERE id = $1`, [req.params.id]).catch(() => {});
    clearStorageScanCache();
    return res.json({ success: true });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/directory-activity', async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email query parameter is required' });

  // Read from DB cache (populated by sync-messages)
  let lastEmailAt             = null;
  let outlookSentToThem       = 0;
  let outlookReceivedFromThem = 0;
  let outlookHint             = null;
  let outlookError            = null;

  try {
    const cached = await mailStore.getStatsForEmail(email);
    if (cached) {
      lastEmailAt             = cached.last_email_at ? new Date(cached.last_email_at).toISOString() : null;
      outlookSentToThem       = cached.sent_to_them  || 0;
      outlookReceivedFromThem = cached.received_from || 0;
    } else {
      outlookHint = 'No data yet — click "Sync Mail Stats" in Email / Outlook to scan your mailbox.';
    }
  } catch (e) {
    outlookError = e.message === 'NOT_AUTHENTICATED' ? 'NOT_AUTHENTICATED' : e.message;
  }

  const broadcastCount = await countBroadcastsForEmail(email);

  // Fetch group memberships
  let groups = [];
  try {
    const pool = require('../db/pool');
    const gr = await pool.query(`
      SELECT g.name
      FROM recipient_groups g
      JOIN recipient_group_members m ON g.id = m.group_id
      JOIN contacts c ON c.id = m.contact_id
      WHERE LOWER(TRIM(c.email)) = LOWER(TRIM($1))
      ORDER BY g.name ASC
    `, [email]);
    groups = gr.rows.map(r => r.name);
  } catch(e) {
    console.error('[directory-activity] group fetch error:', e.message);
  }

  return res.json({
    lastEmailAt,
    lastContactLabel: lastEmailAt
      ? new Date(lastEmailAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : null,
    outlookSentToThem,
    outlookReceivedFromThem,
    broadcastCount,
    outlookError,
    outlookHint,
    groups,
  });
});

// ── GET /api/outlook/contacts ─────────────────────────────────────────────
router.get('/contacts', async (req, res) => {
  try {
    lastContactsTrace = {
      requestedAt: new Date().toISOString(),
      mailbox: MS_EMAIL,
    };
    contactsTraceLog(`[Outlook Contacts][REQUEST] GET /api/outlook/contacts started at ${lastContactsTrace.requestedAt}`);
    contactsTraceLog(`[Outlook Contacts][REQUEST] Runtime mailbox MS_USER_EMAIL="${MS_EMAIL || ''}"`);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Outlook-Contacts-Source', 'microsoft-graph-contacts');

    let outlookContacts = [];
    try {
      contactsTraceLog('[Outlook Contacts][REQUEST] Calling fetchOutlookDirectoryItems()');
      outlookContacts = await fetchOutlookDirectoryItems(MS_EMAIL);
      traceContactSample('route-after-fetchOutlookDirectoryItems', outlookContacts, 15);
    } catch (err) {
      contactsTraceWarn('[Outlook Contacts][REQUEST] fetchOutlookDirectoryItems failed:', {
        message: err.message,
        status: err.status || null,
        code: err.code || null,
      });
      if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
      if (err.status === 403 || /access is denied|ErrorAccessDenied|Authorization_RequestDenied|permission|privilege/i.test(`${err.code || ''} ${err.message || ''}`)) {
        return res.status(403).json({
          error: 'OUTLOOK_CONTACTS_PERMISSION_REQUIRED',
          message: 'Grant Microsoft Graph Contacts.Read or Contacts.ReadWrite permission and reconnect Outlook.',
        });
      }
      throw err;
    }

    // Fetch People API to get phone numbers (contacts folder often lacks phone data)
    // People.Read permission required — merge phone numbers by email
    try {
      contactsTraceLog('[Outlook Contacts][STEP 11] Route-level People API phone merge pass starting');
      const peopleList = await fetchAllOutlookPeopleGraphSafe(MS_EMAIL);
      traceContactSample('route-people-phone-pass-list', peopleList, 12);
      if (peopleList && peopleList.length > 0) {
        // Build email → phone map from People API
        const phoneByEmail = new Map();
        for (const p of peopleList) {
          const phone = p.mobilePhone || (p.businessPhones && p.businessPhones[0]) || null;
          if (phone) {
            const emails = (p.emailAddresses || []).map(e => String(e.address || '').trim().toLowerCase()).filter(Boolean);
            for (const em of emails) {
              if (!phoneByEmail.has(em)) phoneByEmail.set(em, phone);
            }
          }
        }
        contactsTraceLog(`[Outlook Contacts] People API phone map size: ${phoneByEmail.size}`);
        lastContactsTrace.people.phoneMapSize = phoneByEmail.size;

        // Merge phone numbers into contacts
        let merged = 0;
        for (const contact of outlookContacts) {
          if (!contact.mobilePhone) {
            const contactEmail = ((contact.emailAddresses || []).map(e => e && e.address).filter(Boolean)[0] || '').trim().toLowerCase();
            if (contactEmail && phoneByEmail.has(contactEmail)) {
              contact.mobilePhone = phoneByEmail.get(contactEmail);
              merged++;
            }
          }
        }
        contactsTraceLog(`[Outlook Contacts] Merged phone numbers from People API: ${merged} contacts updated`);
        lastContactsTrace.people.mergedIntoContacts = merged;
        traceContactSample('route-after-people-phone-pass', outlookContacts, 15);
      } else {
        contactsTraceLog('[Outlook Contacts][STEP 11] People API phone merge skipped because People API returned 0 rows');
      }
    } catch (peopleErr) {
      contactsTraceWarn('[Outlook Contacts] People API phone merge failed (non-fatal):', peopleErr.message);
    }

    const rawAddr = (oc) => ((oc.emailAddresses || []).map(e => e && e.address).filter(Boolean)[0]) || '';

    // Organizational contacts appear as "External" in Outlook People/profile cards.
    // They are not mailbox contacts, so Contacts.Read returns blank/missing phone data.
    try {
      contactsTraceLog('[Outlook Contacts][STEP 12] Route-level OrgContact merge pass starting');
      const orgContacts = await fetchAllOrgContactsGraphSafe();
      traceContactSample('route-orgcontacts-pass-list', orgContacts, 12);
      if (orgContacts && orgContacts.length > 0) {
        const byEmail = new Map();
        for (const contact of outlookContacts) {
          const contactEmail = rawAddr(contact).trim().toLowerCase();
          if (contactEmail && !byEmail.has(contactEmail)) byEmail.set(contactEmail, contact);
        }

        let merged = 0;
        let appended = 0;
        for (const orgContact of orgContacts) {
          const orgEmail = rawAddr(orgContact).trim().toLowerCase();
          if (!orgEmail) continue;
          const existing = byEmail.get(orgEmail);
          if (existing) {
            if (!existing.mobilePhone && orgContact.mobilePhone) {
              existing.mobilePhone = orgContact.mobilePhone;
              existing.businessPhones = orgContact.businessPhones || existing.businessPhones || [];
              existing.resolvedPhone = orgContact.resolvedPhone;
              existing.resolvedPhoneSource = orgContact.resolvedPhoneSource;
              existing.orgContactId = orgContact.orgContactId;
              merged++;
            }
          } else {
            outlookContacts.push(orgContact);
            byEmail.set(orgEmail, orgContact);
            appended++;
          }
        }
        lastContactsTrace.orgContacts.mergedIntoContacts = merged;
        lastContactsTrace.orgContacts.appendedToContacts = appended;
        contactsTraceLog(`[Outlook OrgContacts][TRACE] Merged ${merged}, appended ${appended}`);
        traceContactSample('route-after-orgcontacts-pass', outlookContacts, 15);
      } else {
        contactsTraceLog('[Outlook Contacts][STEP 12] OrgContact merge skipped because OrgContact API returned 0 rows');
      }
    } catch (orgErr) {
      contactsTraceWarn('[Outlook Contacts] Org contacts merge failed (non-fatal):', orgErr.message);
    }

    outlookContacts.sort((a, b) => {
      const na = (a.displayName || rawAddr(a) || '').trim();
      const nb = (b.displayName || rawAddr(b) || '').trim();
      return na.localeCompare(nb, undefined, { sensitivity: 'base' });
    });
    outlookContacts.forEach(normalizeDirectoryPhoneFields);

    // Bulk attach mail stats and groups
    try {
      const allEmails = [...new Set(outlookContacts.map(c => rawAddr(c).trim().toLowerCase()).filter(Boolean))];
      if (allEmails.length) {
        const pool = require('../db/pool');

        const statsRes = await pool.query(`SELECT email, last_email_at FROM outlook_mail_stats WHERE email = ANY($1)`, [allEmails]);
        const statsMap = new Map();
        statsRes.rows.forEach(r => statsMap.set(r.email.toLowerCase(), r.last_email_at));

        const grpRes = await pool.query(`
          SELECT LOWER(TRIM(c.email)) as email, g.name
          FROM recipient_groups g
          JOIN recipient_group_members m ON g.id = m.group_id
          JOIN contacts c ON c.id = m.contact_id
          WHERE LOWER(TRIM(c.email)) = ANY($1)
        `, [allEmails]);
        const grpMap = new Map();
        grpRes.rows.forEach(r => {
          const em = r.email;
          if (!grpMap.has(em)) grpMap.set(em, []);
          grpMap.get(em).push(r.name);
        });

        for (const oc of outlookContacts) {
          const e = rawAddr(oc).trim().toLowerCase();
          if (e) {
            oc.lastEmailAt = statsMap.get(e) || null;
            oc.groups = grpMap.get(e) || [];
          } else {
            oc.groups = [];
          }
        }
      }
    } catch(e) {
      console.error('[Outlook Contacts] Failed to bulk fetch stats/groups', e.message);
    }

    traceContactSample('route-final-response', outlookContacts, 20);
    res.set('X-Outlook-Contacts-Trace', safeHeaderValue(contactsTraceHeaderSummary(lastContactsTrace)));
    contactsTraceLog('[Outlook Contacts][TRACE] Final trace summary:', JSON.stringify(lastContactsTrace, null, 2));
    console.log(`[Outlook Contacts][REQUEST] completed: returned=${outlookContacts.length}, withPhone=${outlookContacts.filter(c => contactPhoneSummary(c).hasAnyPhone).length}. Full trace is in browser DevTools Network response via ?debug=1.`);
    if (req.query.debug === '1') {
      return res.json({
        contacts: outlookContacts,
        trace: lastContactsTrace,
        summary: contactsTraceHeaderSummary(lastContactsTrace),
      });
    }
    return res.json(outlookContacts);
  } catch (err) {
    console.error('[Outlook Contacts][REQUEST] GET /api/outlook/contacts failed:', {
      message: err.message,
      status: err.status || null,
      code: err.code || null,
      stack: err.stack,
    });
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outlook/contacts ────────────────────────────────────────────
router.post('/contacts', async (req, res) => {
  const { givenName, surname, mobilePhone, companyName, jobTitle } = req.body;
  const firstEmail = Array.isArray(req.body.emailAddresses)
    ? req.body.emailAddresses.map(e => e && (e.address || e.email)).find(Boolean)
    : '';
  const email = String(req.body.email || firstEmail || '').trim();
  const displayName = String(req.body.displayName || [givenName, surname].filter(Boolean).join(' ') || email).trim();

  if (!displayName || !email) {
    return res.status(400).json({ error: 'displayName and email are required' });
  }

  const body = {
    displayName,
    emailAddresses: [{ address: email, name: displayName }],
    ...(givenName   ? { givenName }   : {}),
    ...(surname     ? { surname }     : {}),
    ...(mobilePhone ? { mobilePhone } : {}),
    ...(companyName ? { companyName } : {}),
    ...(jobTitle    ? { jobTitle }    : {}),
  };

  try {
    const created = await graph.graphPost('/me/contacts', body, MS_EMAIL);
    try {
      activityLog.append({ type: 'info', service: 'outlook', message: `Contact saved to Outlook: ${displayName} (${email})`, timestamp: new Date().toISOString() });
    } catch(_) {}
    return res.status(201).json({
      id:             created.id,
      displayName:    created.displayName,
      emailAddresses: created.emailAddresses,
    });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') {
      return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    }
    return res.status(502).json({ error: err.message });
  }
});

// ── PATCH /api/outlook/contacts/:id ──────────────────────────────────────
router.patch('/contacts/:id', async (req, res) => {
  const { id } = req.params;
  const { givenName, surname, mobilePhone, companyName, jobTitle } = req.body;
  const firstEmail = Array.isArray(req.body.emailAddresses)
    ? req.body.emailAddresses.map(e => e && (e.address || e.email)).find(Boolean)
    : '';
  const email = String(req.body.email || firstEmail || '').trim();
  const displayName = String(req.body.displayName || [givenName, surname].filter(Boolean).join(' ') || email).trim();

  if (!displayName) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  if (!id || id.startsWith('mail:')) {
    return res.status(400).json({ error: 'Cannot update a mail-derived contact. Use POST to create a new one.' });
  }

  const body = {
    displayName,
    ...(givenName   ? { givenName }   : {}),
    ...(surname     ? { surname }     : {}),
    ...(mobilePhone ? { mobilePhone } : {}),
    ...(companyName ? { companyName } : {}),
    ...(jobTitle    ? { jobTitle }    : {}),
    ...(email       ? { emailAddresses: [{ address: email, name: displayName }] } : {}),
  };

  try {
    const updated = await graph.graphPatch(`/me/contacts/${encodeURIComponent(id)}`, body, MS_EMAIL);
    try {
      activityLog.append({ type: 'info', service: 'outlook', message: `Contact updated in Outlook: ${displayName}`, timestamp: new Date().toISOString() });
    } catch(_) {}
    return res.status(200).json({ success: true, displayName: updated.displayName || displayName });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') {
      return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    }
    return res.status(502).json({ error: err.message });
  }
});

// ── DELETE /api/outlook/contacts/:id ─────────────────────────────────────
router.delete('/contacts/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || id.startsWith('mail:')) {
    return res.status(400).json({ error: 'Cannot delete a mail-derived contact.' });
  }
  try {
    await graph.graphDelete(`/me/contacts/${encodeURIComponent(id)}`, MS_EMAIL);
    try {
      activityLog.append({ type: 'info', service: 'outlook', message: `Contact deleted from Outlook: ${id}`, timestamp: new Date().toISOString() });
    } catch(_) {}
    return res.json({ success: true });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(502).json({ error: err.message });
  }
});

// ── DELETE /api/outlook/contacts (bulk) ───────────────────────────────────
// Body: { ids: ['id1','id2',...] }
router.delete('/contacts', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'ids array is required' });

  const results = { deleted: 0, failed: [] };
  for (const id of ids) {
    if (!id || String(id).startsWith('mail:')) {
      results.failed.push({ id, reason: 'mail-derived contact' });
      continue;
    }
    try {
      await graph.graphDelete(`/me/contacts/${encodeURIComponent(id)}`, MS_EMAIL);
      results.deleted++;
    } catch (err) {
      results.failed.push({ id, reason: err.message });
    }
  }
  try {
    activityLog.append({ type: 'info', service: 'outlook', message: `Bulk delete: ${results.deleted} contacts deleted`, timestamp: new Date().toISOString() });
  } catch(_) {}
  return res.json({ success: true, ...results });
});

// ── POST /api/outlook/contacts/sync ───────────────────────────────────────
// Non-destructive two-way sync: add new Outlook contacts and update CRM fields.
// CRM contacts are never deleted just because Outlook did not return them.
router.post('/contacts/sync', async (req, res) => {
  const palettes = [
    ['#1d4ed8', 'rgba(29,78,216,0.15)'], ['#d97706', 'rgba(217,119,6,0.15)'],
    ['#7c3aed', 'rgba(124,58,237,0.15)'], ['#059669', 'rgba(5,150,105,0.15)'],
    ['#dc2626', 'rgba(220,38,38,0.15)'], ['#0891b2', 'rgba(8,145,178,0.15)'],
    ['#65a30d', 'rgba(101,163,13,0.15)'], ['#9333ea', 'rgba(147,51,234,0.15)'],
  ];
  try {
    // 1. Fetch all Outlook contacts
    lastContactsTrace = {
      requestedAt: new Date().toISOString(),
      mailbox: MS_EMAIL,
      mode: 'sync',
    };
    const outlookContacts = await fetchOutlookDirectoryItems(MS_EMAIL);

    console.log(`[Outlook Sync] Total Outlook contacts: ${outlookContacts.length}`);

    // Build a set of Outlook emails (lowercase) and Graph IDs for fast lookup
    const outlookEmailSet = new Set();
    const outlookGraphIdSet = new Set();
    for (const oc of outlookContacts) {
      const email = (oc.emailAddresses || []).map(e => e.address).filter(Boolean)[0] || null;
      if (email) outlookEmailSet.add(email.trim().toLowerCase());
      if (oc.id) outlookGraphIdSet.add(oc.id);
    }

    console.log(`[Outlook Sync] Outlook email set (${outlookEmailSet.size}):`, [...outlookEmailSet]);
    console.log(`[Outlook Sync] Outlook Graph ID set (${outlookGraphIdSet.size}):`, [...outlookGraphIdSet]);

    // 2. Fetch all CRM contacts that were imported from Outlook (have Graph ID in notes)
    //    OR have an email that matches an Outlook contact
    const crmResult = await pool.query(`SELECT id, email, notes, fname, lname FROM contacts`);
    const crmContacts = crmResult.rows;

    console.log(`[Outlook Sync] Total CRM contacts: ${crmContacts.length}`);
    crmContacts.forEach(c => {
      const isOutlookImported = c.notes && c.notes.includes('Graph ID:');
      console.log(`[Outlook Sync][CRM] id=${c.id} name="${c.fname} ${c.lname}" email="${c.email}" outlookImported=${isOutlookImported} notes="${c.notes}"`);
    });

    // 3. Non-destructive sync: never delete CRM contacts here. Graph can miss
    // folders/accounts temporarily, and CRM contacts are needed for WhatsApp/calls.
    let deleted = 0;
    for (const crm of crmContacts) {
      const isOutlookImported = crm.notes && crm.notes.includes('Graph ID:');
      console.log(`[Outlook Sync][KEEP] id=${crm.id} "${crm.fname} ${crm.lname}" outlookImported=${isOutlookImported}`);
    }

    // 4. Add new contacts and update phone numbers for existing ones
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const oc of outlookContacts) {
      const primaryEmail = (oc.emailAddresses || []).map(e => e.address).filter(Boolean)[0] || null;
      const graphMarker = mergeOutlookGraphMarker('', oc.id);

      let phone = directoryPrimaryPhone(oc);

      // Check if already in CRM by email or Graph ID
      let existing = null;
      if (primaryEmail) {
        const r = await pool.query(
          `SELECT id, phone, fname, lname, company, designation, notes
           FROM contacts WHERE email IS NOT NULL AND LOWER(TRIM(email)) = LOWER(TRIM($1))`,
          [primaryEmail]
        );
        if (r.rowCount) existing = r.rows[0];
      }
      if (!existing) {
        const r = await pool.query(
          `SELECT id, phone, fname, lname, company, designation, notes FROM contacts WHERE notes LIKE $1`,
          [`%Graph ID: ${oc.id}%`]
        );
        if (r.rowCount) existing = r.rows[0];
      }

      if (existing) {
        const { fname, lname } = splitOutlookContactName(oc);
        const contactEmail = String(primaryEmail || '').trim().toLowerCase();
        const displayName = String(oc.displayName || '').trim().toLowerCase();
        const hasUsefulName = !!displayName && displayName !== contactEmail;
        const nextFname = hasUsefulName ? fname : existing.fname;
        const nextLname = hasUsefulName ? lname : existing.lname;
        const nextCompany = (oc.companyName && String(oc.companyName).trim()) || existing.company || '-';
        const nextDesignation = (oc.jobTitle && String(oc.jobTitle).trim()) || existing.designation || null;
        const nextPhone = phone || existing.phone || null;
        const nextNotes = mergeOutlookGraphMarker(existing.notes, oc.id);
        const changed =
          String(existing.phone || '') !== String(nextPhone || '') ||
          String(existing.fname || '') !== String(nextFname || '') ||
          String(existing.lname || '') !== String(nextLname || '') ||
          String(existing.company || '') !== String(nextCompany || '') ||
          String(existing.designation || '') !== String(nextDesignation || '') ||
          String(existing.notes || '') !== String(nextNotes || '');

        if (changed) {
          console.log(`[Outlook Sync][UPDATE CRM] id=${existing.id} phone="${existing.phone || ''}" -> "${nextPhone || ''}"`);
          await pool.query(
            `UPDATE contacts
             SET fname=$1, lname=$2, company=$3, designation=$4, phone=$5, notes=$6
             WHERE id=$7`,
            [nextFname, nextLname, nextCompany, nextDesignation, nextPhone, nextNotes, existing.id]
          );
          updated++;
        } else {
          console.log(`[Outlook Sync][SKIP UPDATE] id=${existing.id} - no CRM changes needed. outlookPhone="${phone}" crmPhone="${existing.phone}"`);
          skipped++;
        }
        continue;
      }

      if (!phone) {
        console.log(`[Outlook Sync][SKIP INSERT] "${oc.displayName}" email="${primaryEmail}" — no mobile number`);
        skipped++;
        continue;
      }

      // Insert new contact
      console.log(`[Outlook Sync][INSERT] "${oc.displayName}" email="${primaryEmail}" phone="${phone}"`);
      const { fname, lname } = splitOutlookContactName(oc);
      const company = (oc.companyName && String(oc.companyName).trim()) || '-';
      const designation = (oc.jobTitle && String(oc.jobTitle).trim()) || null;
      const [avatar_color, avatar_bg] = palettes[Math.floor(Math.random() * palettes.length)];
      let initials = `${(fname[0] || '?')}${lname && lname !== '-' ? lname[0] : ''}`.toUpperCase();
      if (initials.length < 2) initials = (fname.slice(0, 2) || 'UC').toUpperCase();

      await pool.query(
        `INSERT INTO contacts
          (fname,lname,company,designation,dept,phone,wa,email,segment,score,products,city,notes,avatar_color,avatar_bg,initials,last_contact)
         VALUES ($1,$2,$3,$4,null,$5,null,$6,'Prospect',50,null,null,$7,$8,$9,$10,'—')`,
        [fname, lname, company, designation, phone, primaryEmail, graphMarker, avatar_color, avatar_bg, initials]
      );
      imported++;
    }

    try {
      await pool.query(
        `INSERT INTO audit_log (user_id,action,entity,detail) VALUES ($1,$2,$3,$4)`,
        [req.user.id, 'SYNC', 'contacts', `Outlook sync: added ${imported}, updated ${updated}, deleted ${deleted}, skipped ${skipped}, total Outlook ${outlookContacts.length}`]
      );
    } catch (_) {}

    try {
      activityLog.append({ type: 'info', service: 'outlook', message: `Outlook contacts synced — added ${imported}, updated ${updated}, deleted ${deleted}`, timestamp: new Date().toISOString() });
    } catch (_) {}

    return res.json({ ok: true, imported, updated, deleted, skipped, total: outlookContacts.length });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    console.error('[Outlook] contacts/sync', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outlook/contacts/import ─────────────────────────────────────
router.post('/contacts/import', async (req, res) => {
  const palettes = [
    ['#1d4ed8', 'rgba(29,78,216,0.15)'], ['#d97706', 'rgba(217,119,6,0.15)'],
    ['#7c3aed', 'rgba(124,58,237,0.15)'], ['#059669', 'rgba(5,150,105,0.15)'],
    ['#dc2626', 'rgba(220,38,38,0.15)'], ['#0891b2', 'rgba(8,145,178,0.15)'],
    ['#65a30d', 'rgba(101,163,13,0.15)'], ['#9333ea', 'rgba(147,51,234,0.15)'],
  ];
  try {
    lastContactsTrace = {
      requestedAt: new Date().toISOString(),
      mailbox: MS_EMAIL,
      mode: 'import',
    };
    const all = await fetchOutlookDirectoryItems(MS_EMAIL);
    let imported = 0;
    let skipped = 0;
    for (const oc of all) {
      const primaryEmail = (oc.emailAddresses || []).map((e) => e.address).filter(Boolean)[0] || null;
      const graphMarker = mergeOutlookGraphMarker('', oc.id);
      if (primaryEmail) {
        const dup = await pool.query(
          `SELECT id FROM contacts WHERE email IS NOT NULL AND LOWER(TRIM(email)) = LOWER(TRIM($1))`,
          [primaryEmail]
        );
        if (dup.rowCount) {
          skipped++;
          continue;
        }
      } else {
        const dup = await pool.query(`SELECT id FROM contacts WHERE notes LIKE $1`, [`%Graph ID: ${oc.id}%`]);
        if (dup.rowCount) {
          skipped++;
          continue;
        }
      }
      const { fname, lname } = splitOutlookContactName(oc);
      const company = (oc.companyName && String(oc.companyName).trim()) || '-';
      const designation = (oc.jobTitle && String(oc.jobTitle).trim()) || null;
      let phone = directoryPrimaryPhone(oc);
      if (!phone) {
        skipped++;
        continue;
      }
      const [avatar_color, avatar_bg] = palettes[Math.floor(Math.random() * palettes.length)];
      let initials = `${(fname[0] || '?')}${lname && lname !== '-' ? lname[0] : ''}`.toUpperCase();
      if (initials.length < 2) initials = (fname.slice(0, 2) || 'UC').toUpperCase();

      await pool.query(
        `INSERT INTO contacts
          (fname,lname,company,designation,dept,phone,wa,email,segment,score,products,city,notes,avatar_color,avatar_bg,initials,last_contact)
         VALUES ($1,$2,$3,$4,null,$5,null,$6,'Prospect',50,null,null,$7,$8,$9,$10,'—')`,
        [fname, lname, company, designation, phone, primaryEmail, graphMarker, avatar_color, avatar_bg, initials]
      );
      imported++;
    }
    try {
      await pool.query(
        `INSERT INTO audit_log (user_id,action,entity,detail) VALUES ($1,$2,$3,$4)`,
        [req.user.id, 'IMPORT', 'contacts', `Outlook: imported ${imported}, skipped ${skipped}, total ${all.length}`]
      );
    } catch (_) {}
    return res.json({ ok: true, imported, skipped, total: all.length });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    console.error('[Outlook] contacts/import', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outlook/sync-messages ──────────────────────────────────────
// Fetches latest 100 msgs immediately, rest in background.
router.post('/sync-messages', async (req, res) => {
  try {
    const result = await mailStore.quickSync(MS_EMAIL);
    try {
      activityLog.append({ type: 'info', service: 'outlook', message: `Mail sync completed — ${result.first_batch || 0} messages synced`, timestamp: new Date().toISOString() });
    } catch(_) {}
    return res.json({
      ok: true,
      first_batch:  result.first_batch,
      has_more:     result.has_more,
      synced_at:    result.synced_at,
    });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    console.error('[Outlook] sync-messages error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/sync-progress ───────────────────────────────────────
// Poll this to show background sync progress in the UI.
router.get('/sync-progress', async (req, res) => {
  const state = mailStore.getSyncState();
  const count = await mailStore.messageCount();
  return res.json({ ...state, message_count: count });
});

// ── POST /api/outlook/sync-stats (backward compat) ───────────────────────
router.post('/sync-stats', async (req, res) => {
  try {
    const result = await mailStore.quickSync(MS_EMAIL);
    try {
      activityLog.append({ type: 'info', service: 'outlook', message: `Mail stats sync completed — ${result.first_batch || 0} records updated`, timestamp: new Date().toISOString() });
    } catch(_) {}
    return res.json({
      ok: true,
      upserted: result.first_batch,
      synced_at: result.synced_at,
    });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    console.error('[Outlook] sync-stats error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/sync-status ─────────────────────────────────────────
router.get('/sync-status', async (req, res) => {
  try {
    const t = await mailStore.lastSyncedAt();
    const n = await mailStore.messageCount();
    return res.json({ synced_at: t, message_count: n });
  } catch (_) {
    return res.json({ synced_at: null, message_count: 0 });
  }
});

// ── GET /api/outlook/settings/auto-reply ─────────────────────────────────
router.get('/settings/auto-reply', async (req, res) => {
  try {
    const data = await graphSettingsFetch('/me/mailboxSettings/automaticRepliesSetting');
    return res.json(data);
  } catch (err) {
    return sendOutlookSettingsError(res, err);
  }
});

// ── PATCH /api/outlook/settings/auto-reply ────────────────────────────────
router.patch('/settings/auto-reply', async (req, res) => {
  try {
    const data = await graphSettingsFetch('/me/mailboxSettings', {
      method: 'PATCH',
      body: { automaticRepliesSetting: req.body },
    });
    return res.json(data);
  } catch (err) {
    return sendOutlookSettingsError(res, err);
  }
});

// ── GET /api/outlook/settings/categories ─────────────────────────────────
router.get('/settings/categories', async (req, res) => {
  try {
    const data = await graphSettingsFetch('/me/outlook/masterCategories');
    return res.json(data.value || []);
  } catch (err) {
    return sendOutlookSettingsError(res, err);
  }
});

// ── GET /api/outlook/settings/storage ────────────────────────────────────
router.get('/settings/storage', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const folderData = await graph.graphGet(
      '/me/mailFolders?$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount&$top=50',
      MS_EMAIL
    );
    const folders = folderData.value || [];

    let quota = null;
    try {
      const settings = await graph.graphGet('/me/mailboxSettings', MS_EMAIL);
      quota = settings;
    } catch(_) {}

    let usage = null;
    let usageError = null;
    try {
      usage = await getMailboxUsageReport(MS_EMAIL);
    } catch (e) {
      usageError = friendlyMailboxUsageError(e);
    }

    const outlookSnapshot = readOutlookStorageSnapshot();

    let liveStorage = null;
    let liveStorageError = null;
    try {
      liveStorage = await getLiveFolderStorageStats(folders, MS_EMAIL);
      for (const folder of folders) {
        folder.sizeInBytes = liveStorage.folderBytesById[folder.id] || 0;
      }
    } catch (e) {
      liveStorageError = {
        code: 'MESSAGE_SIZE_SCAN_FAILED',
        message: e.message || 'Could not scan message sizes.',
      };
    }

    const liveStorageHasSizes = !!(liveStorage && Number(liveStorage.sizedMessages || 0) > 0);
    if (outlookSnapshot && Array.isArray(outlookSnapshot.folders)) {
      const snapshotByName = new Map(outlookSnapshot.folders.map((f, index) => {
        f.storageSortOrder = index;
        return [storageFolderKey(f.displayName), f];
      }));
      const seenSnapshotKeys = new Set();
      for (const folder of folders) {
        const snap = snapshotByName.get(storageFolderKey(folder.displayName));
        if (snap) {
          seenSnapshotKeys.add(storageFolderKey(snap.displayName));
          folder.sizeInBytes = Number(snap.sizeBytes || 0);
          folder.storageSortOrder = snap.storageSortOrder;
          folder.outlookStorageSnapshot = true;
        }
      }
      for (const snap of outlookSnapshot.folders) {
        const key = storageFolderKey(snap.displayName);
        if (seenSnapshotKeys.has(key)) continue;
        folders.push({
          id: `snapshot-${key}`,
          displayName: snap.displayName,
          totalItemCount: Number(snap.messageCount || 0),
          unreadItemCount: 0,
          childFolderCount: 0,
          sizeInBytes: Number(snap.sizeBytes || 0),
          storageSortOrder: snap.storageSortOrder,
          outlookStorageSnapshot: true,
          snapshotOnly: true,
        });
      }
    }

    return res.json({
      mailbox: MS_EMAIL,
      quota,
      outlookSnapshot,
      usage,
      usageError,
      liveStorage,
      liveStorageError,
      usageStatus: liveStorageHasSizes ? 'message-scan' : (usage ? 'report' : (outlookSnapshot ? 'snapshot-fallback' : 'folder-counts')),
      folders,
    });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/settings/shared ─────────────────────────────────────
router.get('/settings/shared', async (req, res) => {
  try {
    // Get shared mailboxes the user has access to
    const data = await graph.graphGet(
      '/me/mailFolders?$filter=isHidden eq false&$select=displayName,totalItemCount,unreadItemCount&$top=50',
      MS_EMAIL
    );
    return res.json(data.value || []);
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/settings/signatures', async (_req, res) => {
  try {
    const rows = await getSignatureRows();
    return res.json({
      signatures: rows,
      defaultNewId: rows.find(s => s.is_default_new)?.id || null,
      defaultReplyId: rows.find(s => s.is_default_reply)?.id || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/settings/signatures', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const html = String(req.body.html_body || '').trim();
  const defaultNew = !!req.body.is_default_new;
  const defaultReply = !!req.body.is_default_reply;
  if (!name) return res.status(400).json({ error: 'Signature name is required.' });
  if (!html) return res.status(400).json({ error: 'Signature content is required.' });
  try {
    await ensureSignatureTable();
    const r = await pool.query(
      `INSERT INTO outlook_signatures (user_email, name, html_body, is_default_new, is_default_reply)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, html_body, is_default_new, is_default_reply, created_at, updated_at`,
      [MS_EMAIL, name, html, defaultNew, defaultReply]
    );
    const row = r.rows[0];
    if (defaultNew) await setSignatureDefault('new', row.id);
    if (defaultReply) await setSignatureDefault('reply', row.id);
    const rows = await getSignatureRows();
    return res.json({
      signature: rows.find(s => s.id === row.id) || row,
      signatures: rows,
      defaultNewId: rows.find(s => s.is_default_new)?.id || null,
      defaultReplyId: rows.find(s => s.is_default_reply)?.id || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/settings/signatures/defaults', async (req, res) => {
  const kind = req.body.kind === 'reply' ? 'reply' : 'new';
  const id = req.body.id ? Number(req.body.id) : null;
  try {
    await setSignatureDefault(kind, id);
    const rows = await getSignatureRows();
    return res.json({
      signatures: rows,
      defaultNewId: rows.find(s => s.is_default_new)?.id || null,
      defaultReplyId: rows.find(s => s.is_default_reply)?.id || null,
    });
  } catch (err) {
    return res.status(/not found/i.test(err.message) ? 404 : 500).json({ error: err.message });
  }
});

router.patch('/settings/signatures/:id', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const html = String(req.body.html_body || '').trim();
  const defaultNew = !!req.body.is_default_new;
  const defaultReply = !!req.body.is_default_reply;
  if (!name) return res.status(400).json({ error: 'Signature name is required.' });
  if (!html) return res.status(400).json({ error: 'Signature content is required.' });
  try {
    await ensureSignatureTable();
    const r = await pool.query(
      `UPDATE outlook_signatures
       SET name=$1, html_body=$2, updated_at=NOW()
       WHERE user_email=$3 AND id=$4
       RETURNING id`,
      [name, html, MS_EMAIL, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Signature not found' });
    if (defaultNew) await setSignatureDefault('new', req.params.id);
    if (defaultReply) await setSignatureDefault('reply', req.params.id);
    const rows = await getSignatureRows();
    return res.json({
      signatures: rows,
      defaultNewId: rows.find(s => s.is_default_new)?.id || null,
      defaultReplyId: rows.find(s => s.is_default_reply)?.id || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/settings/signatures/:id', async (req, res) => {
  try {
    await ensureSignatureTable();
    await pool.query(`DELETE FROM outlook_signatures WHERE user_email=$1 AND id=$2`, [MS_EMAIL, req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/settings/categories', async (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  const color = String(req.body.color || 'preset0').trim();
  if (!displayName) return res.status(400).json({ error: 'Category name is required.' });
  try {
    const data = await graphSettingsFetch('/me/outlook/masterCategories', {
      method: 'POST',
      body: { displayName, color },
    });
    return res.json(data);
  } catch (err) {
    return sendOutlookSettingsError(res, err);
  }
});

router.patch('/settings/categories/:id', async (req, res) => {
  const patch = {};
  if (req.body.displayName !== undefined) patch.displayName = String(req.body.displayName || '').trim();
  if (req.body.color !== undefined) patch.color = String(req.body.color || '').trim();
  if (patch.displayName === '') return res.status(400).json({ error: 'Category name is required.' });
  try {
    const data = await graphSettingsFetch(`/me/outlook/masterCategories/${encodeURIComponent(req.params.id)}`, {
      method: 'PATCH',
      body: patch,
    });
    return res.json(data);
  } catch (err) {
    return sendOutlookSettingsError(res, err);
  }
});

router.delete('/settings/categories/:id', async (req, res) => {
  try {
    const token = await graph.getClientCredentialsToken(true) || await graph.getAccessToken(MS_EMAIL);
    if (!token) throw new Error('NOT_AUTHENTICATED');
    const url = `${GRAPH_ROOT}/users/${encodeURIComponent(MS_EMAIL)}/outlook/masterCategories/${encodeURIComponent(req.params.id)}`;
    const delRes = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!delRes.ok && delRes.status !== 404) {
      const err = await delRes.json().catch(() => ({}));
      const graphErr = new Error(err.error?.message || `Graph API error ${delRes.status}`);
      graphErr.status = delRes.status;
      graphErr.code = err.error?.code;
      throw graphErr;
    }
    return res.json({ success: true });
  } catch (err) {
    return sendOutlookSettingsError(res, err);
  }
});

// ── POST /api/outlook/ai-assistant/model-test ────────────────────────────
// Sends "hi" to the cloud API (Groq) to measure actual lightning-fast response times.
router.post('/ai-assistant/model-test', authenticate, async (req, res) => {
  const fetch = require('node-fetch');
  const aiHost  = process.env.AI_API_HOST  || 'https://api.groq.com/openai/v1';
  const aiModel = resolvePicoClawModel();
  const aiToken = process.env.AI_API_KEY   || '';
  const AI_TIMEOUT_MS = 60000;

  console.log(`\n[AI-TEST] ═══ Model Ping Test started ═══`);
  console.log(`[AI-TEST] Target: ${aiHost} (${aiModel})`);

  const t_start = Date.now();
  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => abortCtrl.abort(), AI_TIMEOUT_MS);

  let t_sent, t_received, responseData;

  try {
    t_sent = Date.now();
    console.log(`[AI-TEST] 📤 Request sent at +${t_sent - t_start}ms`);

    const headers = { 'Content-Type': 'application/json' };
    if (aiToken) headers['Authorization'] = `Bearer ${aiToken}`;

    const response = await fetch(`${aiHost}/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: aiModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 20,
        temperature: 0.1
      }),
      signal: abortCtrl.signal
    });

    clearTimeout(abortTimer);
    t_received = Date.now();

    if (!response.ok) {
      const txt = await response.text();
      return res.status(503).json({ error: `API error ${response.status}: ${txt}` });
    }

    responseData = await response.json();

  } catch (fetchErr) {
    clearTimeout(abortTimer);
    const elapsed = Date.now() - t_start;
    return res.status(503).json({ error: `Test failed after ${elapsed}ms: ${fetchErr.message}` });
  }

  const t_end = Date.now();

  const network_send_ms    = t_sent - t_start;
  const roundtrip_ms       = t_received - t_sent;
  const parse_ms           = t_end - t_received;
  const total_wall_ms      = t_end - t_start;

  const timing = {
    phases: {
      js_send_overhead_ms:     network_send_ms,
      response_generation_ms:  roundtrip_ms,
      json_parse_ms:           parse_ms,
    },
    totals: {
      wall_clock_ms:    total_wall_ms,
      roundtrip_ms,
    },
    model: {
      name:       aiModel,
      response_text:  responseData.choices?.[0]?.message?.content || '',
    },
    status: 'online',
  };

  console.log(`[AI-TEST] ┌─ Groq Phase Breakdown ───────────────────────`);
  console.log(`[AI-TEST] │ 📤 JS send overhead:      ${network_send_ms}ms`);
  console.log(`[AI-TEST] │ 🤖 Response generation:   ${roundtrip_ms}ms  <-- (Instant!)`);
  console.log(`[AI-TEST] │ ⚙️  JSON parse:             ${parse_ms}ms`);
  console.log(`[AI-TEST] ├─ Totals ───────────────────────────────────`);
  console.log(`[AI-TEST] │ Wall clock:    ${total_wall_ms}ms`);
  console.log(`[AI-TEST] │ Reply: "${responseData.choices?.[0]?.message?.content || ''}"`);
  console.log(`[AI-TEST] └────────────────────────────────────────────\n`);

  return res.json({ success: true, timing });
});

// ── POST /api/outlook/ai-assistant/analyze ───────────────────────────────
// MINIMAL SINGLE-CALL AI ANALYSIS — no queue, no polling, no complexity
router.post('/ai-assistant/analyze', authenticate, async (req, res) => {
  console.log('[AI] === AI request started ===');

  try {
    // --- 1. Fetch latest email ---
    const emailRes = await pool.query(`
      SELECT subject, from_name, from_address, received_datetime, body_preview, is_read, importance
      FROM outlook_emails_cache
      WHERE COALESCE(subject, '') <> ''
      ORDER BY received_datetime DESC NULLS LAST, synced_at DESC
      LIMIT 1
    `);

    if (!emailRes.rows.length) {
      console.log('[AI] No emails found in cache.');
      return res.status(400).json({ error: 'No emails found for analysis.' });
    }

    const email = emailRes.rows[0];
    console.log(`[AI] Analyzing email: "${email.subject || '(no subject)'}"`);

    // --- 2. Build a simple prompt ---
    const prompt = [
      'You are an AI email assistant for a B2B sales team in India.',
      'Analyze the following email and reply in this exact format only:',
      '',
      'Summary: <one short sentence about what this email is about>',
      'Insights:',
      '- <short insight 1>',
      '- <short insight 2>',
      '- <short insight 3>',
      'Smart Actions:',
      '1. <short action 1>',
      '2. <short action 2>',
      '3. <short action 3>',
      '',
      'Rules: keep the whole answer under 130 words; be specific; do not invent facts; no extra headings.',
      '',
      '--- EMAIL ---',
      `Subject: ${email.subject || '(no subject)'}`,
      `From: ${email.from_name || email.from_address || 'Unknown'}`,
      `Received: ${email.received_datetime ? new Date(email.received_datetime).toLocaleString('en-IN') : 'Unknown'}`,
      `Status: ${email.is_read ? 'Read' : 'Unread'}${email.importance === 'high' ? ', HIGH IMPORTANCE' : ''}`,
      `Preview: ${email.body_preview || '(no preview)'}`,
    ].join('\n');

    // --- 3. Call Fast Cloud API (OpenAI-compatible) ---
    // Using generic variables so we can plug in Groq, OpenRouter, etc.
    const aiHost  = process.env.AI_API_HOST  || 'https://api.groq.com/openai';
    const aiBase  = aiHost.replace(/\/v1\/?$/, '');
    const aiModel = resolvePicoClawModel();
    const aiToken = process.env.AI_API_KEY || '';
    const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '60000', 10); // default 60s

    console.log(`[AI] Sending to PicoClaw model: ${aiModel} @ ${aiHost} (timeout: ${AI_TIMEOUT_MS / 1000}s)`);
    console.log('[AI] Waiting for lightning-fast response...');

    const fetch = require('node-fetch');

    const abortCtrl = new AbortController();
    const abortTimer = setTimeout(() => {
      abortCtrl.abort();
      console.warn(`[AI] Hard timeout fired after ${AI_TIMEOUT_MS / 1000}s — aborting PicoClaw fetch`);
    }, AI_TIMEOUT_MS);

    let aiResponse;
    try {
      // PicoClaw uses the standard, fast OpenAI format
      const headers = { 'Content-Type': 'application/json' };
      if (aiToken) {
        headers['Authorization'] = `Bearer ${aiToken}`;
      }

      aiResponse = await fetch(`${aiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: aiModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: parseInt(process.env.AI_MAX_TOKENS || '800', 10),
          temperature: 0.3
        }),
        signal: abortCtrl.signal
      });
    } catch (fetchErr) {
      clearTimeout(abortTimer);
      if (fetchErr.name === 'AbortError') {
        console.error(`[AI] Request aborted — PicoClaw took longer than ${AI_TIMEOUT_MS / 1000}s`);
        return res.status(503).json({
          error: `PicoClaw timed out after ${AI_TIMEOUT_MS / 1000}s. Check if the PicoClaw server is running on ${aiHost}.`
        });
      }
      throw fetchErr;
    }
    clearTimeout(abortTimer);

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      let parsedErr = {};
      try { parsedErr = JSON.parse(errText); } catch(e) {}

      console.error('[AI] PicoClaw API error:', aiResponse.status, errText);

      // Handle Rate Limits (Groq Free Tier)
      if (aiResponse.status === 429) {
        return res.status(429).json({
          error: 'AI Rate Limit Reached',
          message: 'The PicoClaw assistant is temporarily busy. Please wait 15-20 seconds and retry.',
          raw: parsedErr.error?.message || errText
        });
      }

      return res.status(503).json({ error: `PicoClaw error: ${aiResponse.status}`, message: parsedErr.error?.message || 'The AI service is temporarily unavailable.' });
    }

    const aiData = await aiResponse.json();

    // OpenAI/PicoClaw format extraction
    const rawText = aiData.choices?.[0]?.message?.content || aiData.response || '';
    console.log('[AI] Response received. Parsing...');

    // --- 4. Parse the model's plain-text response ---
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    let summary = '';
    const insights = [];
    const smartActions = [];
    let section = null;

    for (const line of lines) {
      if (/^Summary:/i.test(line)) {
        summary = line.replace(/^Summary:/i, '').trim();
        section = 'summary';
      } else if (/^Insights:/i.test(line)) {
        section = 'insights';
      } else if (/^Smart Actions:/i.test(line)) {
        section = 'actions';
      } else if (section === 'summary' && !summary) {
        summary = line;
      } else if (section === 'insights' && (line.startsWith('-') || line.startsWith('•'))) {
        insights.push(line.replace(/^[-•]\s*/, ''));
      } else if (section === 'actions' && /^\d+\./.test(line)) {
        smartActions.push(line);
      }
    }

    if (!summary) summary = 'Analysis complete. See insights below.';
    if (!insights.length) insights.push('Email reviewed successfully.');
    if (!smartActions.length) smartActions.push('1. Review the email and respond if needed.');

    console.log('[AI] === Analysis completed ===');

    return res.json({
      success: true,
      fallback: false,
      summary,
      insights,
      smartActions,
      systemOptimization: [],
      analyzedEmail: {
        subject: email.subject,
        from: email.from_name || email.from_address,
        received: email.received_datetime
      },
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('[AI] Fatal error during analysis:', err.message);
    return res.status(500).json({ error: err.message || 'AI analysis failed.' });
  }
});


// ── POST /api/outlook/disconnect ─────────────────────────────────────────
// Clears stored OAuth tokens so user can reconnect with fresh permissions
router.post('/disconnect', async (req, res) => {
  try {
    await pool.query(`DELETE FROM ms_tokens WHERE user_email = $1`, [MS_EMAIL]);
    console.log('[Outlook] Disconnected — tokens cleared for', MS_EMAIL);
    return res.json({ success: true, message: 'Outlook disconnected. Please reconnect to get fresh token.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
