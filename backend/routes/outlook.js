/**
 * Outlook / Microsoft Graph Routes
 * GET  /api/outlook/status          — check if authenticated
 * GET  /api/outlook/auth            — get OAuth2 login URL
 * GET  /auth/callback               — OAuth2 callback (no JWT needed)
 * GET  /api/outlook/inbox           — list inbox messages
 * GET  /api/outlook/message/:id     — get full message body
 * POST /api/outlook/send            — send email
 * POST /api/outlook/reply/:id       — reply to a message
 * PATCH /api/outlook/message/:id    — mark read / move / categorize
 * GET  /api/outlook/sent            — sent items
 * GET  /api/outlook/folders         — list mail folders
 */
const express  = require('express');
const graph    = require('../services/msGraph');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const MS_EMAIL = process.env.MS_USER_EMAIL;

// ── OAuth callback — no JWT (browser redirect) ────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <html><body style="font-family:sans-serif;background:#0c0f1a;color:#e8ecf4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center;">
          <h2 style="color:#f87171;">Authentication Failed</h2>
          <p>${error_description || error}</p>
          <a href="http://localhost:${process.env.PORT||4551}/dashboard.html" style="color:#f5a623;">← Back to Dashboard</a>
        </div>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send('No authorization code received.');
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
        <script>setTimeout(()=>window.location.href='http://localhost:${process.env.PORT||4551}/dashboard.html',2000)</script>
      </body></html>
    `);
  } catch (err) {
    console.error('[Outlook] OAuth callback error:', err.message);
    return res.status(500).send(`Authentication error: ${err.message}`);
  }
});

// All routes below require JWT
router.use(authenticate);

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

// ── GET /api/outlook/message/:id ──────────────────────────────────────────
router.get('/message/:id', async (req, res) => {
  try {
    const data = await graph.graphGet(
      `/me/messages/${req.params.id}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,hasAttachments,importance`,
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

// ── GET /api/outlook/contacts ─────────────────────────────────────────────
router.get('/contacts', async (req, res) => {
  try {
    const data = await graph.graphGet(
      `/me/contacts?$top=50&$select=id,displayName,emailAddresses,mobilePhone,companyName,jobTitle`,
      MS_EMAIL
    );
    return res.json(data.value || []);
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
