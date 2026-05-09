/**
 * Outlook / Microsoft Graph Routes
 * GET  /api/outlook/status          — check if authenticated
 * GET  /api/outlook/auth            — get OAuth2 login URL
 * GET  /auth/callback               — OAuth2 callback (no JWT needed)
 * GET  /api/outlook/inbox           — list inbox messages
 * GET  /api/outlook/message/:id     — get full message body (+ uniqueBody, attachments)
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
          <a href="${APP_PUBLIC_URL}/dashboard.html" style="color:#f5a623;">← Back to Dashboard</a>
        </div>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;background:#0c0f1a;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;">
        <div style="max-width:420px;text-align:center;">
          <h2 style="color:#f5a623;margin-top:0;">This page is not opened directly</h2>
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
    return res.status(500).json({ error: err.message });
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
    
    return res.json({
      messages,
      nextLink: data['@odata.nextLink'] || null,
      total:    messages.length,
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
    const mid = encodeURIComponent(req.params.messageId);
    const aid = encodeURIComponent(req.params.attachmentId);
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

// ── GET /api/outlook/message/:id ──────────────────────────────────────────
router.get('/message/:id', async (req, res) => {
  try {
    const sel = [
      'id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime',
      'body', 'uniqueBody', 'isRead', 'hasAttachments', 'importance', 'conversationId',
    ].join(',');
    // Do not use attachments($select=…): OData treats the collection as base
    // microsoft.graph.attachment, which has no contentId/contentBytes (those live on fileAttachment).
    const q = `$select=${encodeURIComponent(sel)}&$expand=${encodeURIComponent('attachments')}`;
    const data = await graph.graphGet(
      `/me/messages/${encodeURIComponent(req.params.id)}?${q}`,
      MS_EMAIL
    );
    // Auto-mark as read
    graph.graphPatch(`/me/messages/${req.params.id}`, { isRead: true }, MS_EMAIL).catch(() => {});
    return res.json(data);
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/sent ─────────────────────────────────────────────────
router.get('/sent', async (req, res) => {
  const top  = parseInt(req.query.top  || '25');
  const skip = parseInt(req.query.skip || '0');
  try {
    const data = await graph.graphGet(
      `/me/mailFolders/sentitems/messages?$top=${top}&$skip=${skip}`
      + `&$select=id,subject,toRecipients,sentDateTime,bodyPreview,hasAttachments`
      + `&$orderby=sentDateTime desc`,
      MS_EMAIL
    );
    return res.json({ messages: data.value || [] });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/outlook/folders ──────────────────────────────────────────────
router.get('/folders', async (req, res) => {
  try {
    const data = await graph.graphGet(
      `/me/mailFolders?$select=id,displayName,unreadItemCount,totalItemCount`,
      MS_EMAIL
    );
    return res.json(data.value || []);
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outlook/send ────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  const { to, subject, body, cc, importance } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject, and body are required.' });
  }

  const toRecipients = (Array.isArray(to) ? to : [to]).map(addr => ({
    emailAddress: { address: addr }
  }));
  const ccRecipients = cc
    ? (Array.isArray(cc) ? cc : [cc]).map(addr => ({ emailAddress: { address: addr } }))
    : [];

  const message = {
    subject,
    importance: importance || 'normal',
    body:       { contentType: 'HTML', content: body },
    toRecipients,
    ...(ccRecipients.length ? { ccRecipients } : {}),
  };

  try {
    await graph.graphPost('/me/sendMail', { message, saveToSentItems: true }, MS_EMAIL);

    // Audit log
    pool.query(
      `INSERT INTO audit_log (user_id,action,entity,detail) VALUES ($1,$2,$3,$4)`,
      [req.user.id, 'EMAIL_SENT', 'outlook', `To: ${Array.isArray(to)?to.join(','):to} | Subject: ${subject}`]
    ).catch(() => {});

    // Activity log
    try {
      activityLog.append({ type: 'info', service: 'outlook', message: `Email sent to ${Array.isArray(to)?to.join(', '):to} — "${subject}"`, timestamp: new Date().toISOString() });
    } catch(_) {}

    clearStorageScanCache();
    return res.json({ success: true, message: 'Email sent successfully.' });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/outlook/reply/:id ───────────────────────────────────────────
router.post('/reply/:id', async (req, res) => {
  const { body, replyAll } = req.body;
  if (!body) return res.status(400).json({ error: 'Reply body is required.' });

  const endpoint = replyAll
    ? `/me/messages/${req.params.id}/replyAll`
    : `/me/messages/${req.params.id}/reply`;

  try {
    await graph.graphPost(endpoint, {
      message: { body: { contentType: 'HTML', content: body } },
    }, MS_EMAIL);
    clearStorageScanCache();
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
  const { displayName, email, givenName, surname, mobilePhone, companyName } = req.body;

  if (!displayName || !email) {
    return res.status(400).json({ error: 'displayName and email are required' });
  }
  if (!String(mobilePhone || '').trim()) {
    return res.status(400).json({ error: 'mobilePhone is required for Outlook contact sync' });
  }

  const body = {
    displayName,
    emailAddresses: [{ address: email, name: displayName }],
    ...(givenName   ? { givenName }   : {}),
    ...(surname     ? { surname }     : {}),
    ...(mobilePhone ? { mobilePhone } : {}),
    ...(companyName ? { companyName } : {}),
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
  const { displayName, givenName, surname, mobilePhone, companyName } = req.body;

  if (!displayName) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  if (!String(mobilePhone || '').trim()) {
    return res.status(400).json({ error: 'mobilePhone is required for Outlook contact sync' });
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
