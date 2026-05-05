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
 * POST /api/outlook/contacts/import    — import all into CRM contacts (skip duplicate email / same Graph id)
 */
const express  = require('express');
const fetch    = require('node-fetch');
const graph    = require('../services/msGraph');
const pool     = require('../db/pool');
const mailStats  = require('../services/outlookContactMailStats');
const statsCache = require('../services/outlookStatsCache');
const mailStore  = require('../services/outlookMailStore');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const MS_EMAIL = process.env.MS_USER_EMAIL;

const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || `http://localhost:${process.env.PORT || 8088}`).replace(/\/$/, '');
const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

async function fetchAllOutlookContactsGraph(email) {
  const token = await graph.getAccessToken(email);
  if (!token) throw new Error('NOT_AUTHENTICATED');
  const sel = 'id,displayName,givenName,surname,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle';
  let url = `${GRAPH_ROOT}/me/contacts?$top=500&$select=${encodeURIComponent(sel)}`;
  const rows = [];
  for (let page = 0; page < 100 && url; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Graph API error ${res.status}`);
    }
    const data = await res.json();
    rows.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
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
  const top    = parseInt(req.query.top    || '25');
  const skip   = parseInt(req.query.skip   || '0');
  const filter = req.query.filter || '';

  let endpoint = `/me/mailFolders/inbox/messages?$top=${top}&$skip=${skip}`
    + `&$select=id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments,importance`
    + `&$orderby=receivedDateTime desc`;

  if (filter) endpoint += `&$search="${encodeURIComponent(filter)}"`;

  try {
    const data = await graph.graphGet(endpoint, MS_EMAIL);
    return res.json({
      messages: data.value || [],
      nextLink: data['@odata.nextLink'] || null,
      total:    data['@odata.count']    || null,
    });
  } catch (err) {
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
    const data = await graph.graphGet(
      `/me/messages?$filter=${filter}&$top=50&$orderby=receivedDateTime asc`
      + `&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`,
      MS_EMAIL
    );
    return res.json({ messages: data.value || [] });
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
      comment: body,
    }, MS_EMAIL);
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
// Always returns DB-imported contacts. If Outlook is connected, also merges
// live Graph contacts + mail stats. If not connected, DB contacts still show.
router.get('/contacts', async (req, res) => {
  try {
    // ── Step 1: Always load DB-imported contacts ──────────────────────────
    const dbResult = await pool.query(`
      SELECT id, fname, lname, company, designation, email,
             phone, avatar_color, avatar_bg, initials, notes
      FROM contacts
      ORDER BY score DESC, created_at DESC
    `);
    const dbContacts = dbResult.rows.map(c => {
      const displayName = `${c.fname || ''} ${c.lname || ''}`.trim() || c.company || 'Contact';
      const primaryEmail = c.email || '';
      return {
        id: `db:${c.id}`,
        _dbId: c.id,
        displayName,
        givenName:      c.fname || '',
        surname:        c.lname || '',
        emailAddresses: primaryEmail ? [{ address: primaryEmail }] : [],
        mobilePhone:    c.phone || null,
        businessPhones: [],
        companyName:    c.company || null,
        jobTitle:       c.designation || null,
        source:         'db',
        mailStats:      null,
      };
    });

    // ── Step 2: Try to get mail stats from DB cache (no Outlook needed) ───
    let statsMap = new Map();
    try {
      statsMap = await mailStats.buildDirectoryStatsMap(MS_EMAIL, mailStats.MAIL_SCAN_PAGES);
      directoryStatsCache = { map: statsMap, at: Date.now(), mailbox: MS_EMAIL };
    } catch (_) { /* stats unavailable — continue without */ }

    // ── Step 3: Try live Graph contacts (only if Outlook connected) ────────
    let graphContacts = [];
    let outlookConnected = false;
    try {
      graphContacts = await fetchAllOutlookContactsGraph(MS_EMAIL);
      outlookConnected = true;
    } catch (_) { /* not connected — skip */ }

    // ── Step 4: Merge — Graph contacts take priority, DB fills the rest ───
    const seenNorm  = new Set();
    const seenDbIds = new Set();
    const merged    = [];

    function rawAddr(oc) {
      return ((oc.emailAddresses || []).map(e => e && e.address).filter(Boolean)[0]) || '';
    }

    // Add Graph contacts first (with mail stats)
    for (const oc of graphContacts) {
      const raw = rawAddr(oc);
      const n   = raw ? mailStats.norm(raw) : '';
      if (n) seenNorm.add(n);
      const st = n ? statsMap.get(n) : null;
      merged.push({
        ...oc,
        source: 'people',
        mailStats: st ? {
          lastEmailAt:             st.lastEmailAt,
          outlookSentToThem:       st.sentToThem,
          outlookReceivedFromThem: st.receivedFromThem,
        } : null,
      });
    }

    // Add mail-stats-only entries (emails seen in mailbox but not in contacts folder)
    for (const [n, st] of statsMap) {
      if (seenNorm.has(n)) continue;
      const addr  = (st.primaryEmail && mailStats.norm(st.primaryEmail) === n ? st.primaryEmail : n) || n;
      const local = addr.includes('@') ? addr.split('@')[0] : addr;
      merged.push({
        id: `mail:${n}`,
        displayName: local || addr,
        givenName: '', surname: '',
        emailAddresses: [{ address: addr }],
        mobilePhone: null, businessPhones: [],
        companyName: null, jobTitle: null,
        source: 'mail',
        mailStats: {
          lastEmailAt:             st.lastEmailAt,
          outlookSentToThem:       st.sentToThem,
          outlookReceivedFromThem: st.receivedFromThem,
        },
      });
      seenNorm.add(n);
    }

    // Add DB contacts that aren't already represented by Graph/mail entries
    for (const dc of dbContacts) {
      const email = rawAddr(dc);
      const n     = email ? mailStats.norm(email) : '';
      if (n && seenNorm.has(n)) continue; // already in merged via Graph or mail stats
      const st = n ? statsMap.get(n) : null;
      merged.push({
        ...dc,
        mailStats: st ? {
          lastEmailAt:             st.lastEmailAt,
          outlookSentToThem:       st.sentToThem,
          outlookReceivedFromThem: st.receivedFromThem,
        } : null,
      });
    }

    // Sort by last email activity desc, then name
    merged.sort((a, b) => {
      const ta = a.mailStats?.lastEmailAt ? new Date(a.mailStats.lastEmailAt).getTime() : 0;
      const tb = b.mailStats?.lastEmailAt ? new Date(b.mailStats.lastEmailAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      const na = (a.displayName || rawAddr(a) || '').trim();
      const nb = (b.displayName || rawAddr(b) || '').trim();
      return na.localeCompare(nb, undefined, { sensitivity: 'base' });
    });

    return res.json(merged);
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
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
    const all = await fetchAllOutlookContactsGraph(MS_EMAIL);
    let imported = 0;
    let skipped = 0;
    for (const oc of all) {
      const primaryEmail = (oc.emailAddresses || []).map((e) => e.address).filter(Boolean)[0] || null;
      const graphMarker = `Outlook contact · Graph ID: ${oc.id}`;
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
      let phone = (oc.mobilePhone && String(oc.mobilePhone).trim()) || null;
      if (!phone && Array.isArray(oc.businessPhones) && oc.businessPhones.length) {
        phone = String(oc.businessPhones[0]).trim() || null;
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

module.exports = router;
