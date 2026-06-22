/**
 * UniComm Pro — Express REST API
 * Unicircuit Engineering Services LLP
 *
 * Start:  node server.js
 * Dev:    nodemon server.js
 * Init DB: node db/init.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// DEBUG: Check if .env loaded
console.log('[SERVER] .env loaded. SMDR_PORT from env:', process.env.SMDR_PORT);
console.log('[SERVER] .env file path:', require('path').join(__dirname, '.env'));

// Run security checks on startup
const { runStartupSecurityChecks } = require('./utils/securityCheck');
runStartupSecurityChecks();

try {
  require('./services/msGraph').logOutlookOAuthConfigAtStartup();
} catch (e) {
  console.warn('[Outlook] Could not log OAuth env:', e.message);
}

process.on('uncaughtException', (err) => {
  console.error('===================================================');
  console.error('[GLOBAL] Uncaught Exception:', err);
  console.error('Stack:', err.stack);
  console.error('===================================================');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('===================================================');
  console.error('[GLOBAL] Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  console.error('===================================================');
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const axios = require('axios');
const https = require('https');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const wa = require('./services/whatsapp');
const waInventory = require('./services/whatsappInventory');
const smdr = require('./services/matrixSmdr');
const mktCron = require('./services/marketingCron');
const oneDriveSync = require('./services/oneDriveSync');
const taskNotifier = require('./services/taskNotifier');
const automatedAI = require('./services/automatedAI');
const aiTaskQueue = require('./services/aiTaskQueue');
const pool = require('./db/pool');
const activityLog = require('./services/activityLog');
const systemRoutes = require('./routes/system');
const { serviceState } = systemRoutes;
const msGraph = require('./services/msGraph');
const cron = require('node-cron');
const maintenance = require('./services/maintenance');

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// ── DATABASE SCHEMA MIGRATION (Self-Healing) ───────────────────────────────
async function ensureSchema() {
  try {
    // 1. Ensure pbx_recordings table and indexes exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pbx_recordings (
        id SERIAL PRIMARY KEY,
        original_filename VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(255),
        extension_number VARCHAR(30),
        customer_number VARCHAR(30),
        recording_date TIMESTAMPTZ,
        file_size BIGINT,
        backup_folder VARCHAR(255),
        extension_folder VARCHAR(255),
        local_path TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pbx_recordings_original_filename ON pbx_recordings (original_filename)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pbx_recordings_recording_date ON pbx_recordings (recording_date DESC NULLS LAST)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pbx_recordings_lookup ON pbx_recordings (backup_folder, extension_folder)`).catch(() => {});
    console.log('[DB] ✅ pbx_recordings table and indexes ensured.');

    // 2. Ensure mail_reply_tasks table and indexes exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mail_reply_tasks (
        id                    SERIAL PRIMARY KEY,
        message_id            TEXT NOT NULL,
        conversation_id       TEXT,
        subject               TEXT,
        sender_name           TEXT,
        sender_email          TEXT,
        preview               TEXT,
        importance            VARCHAR(20)  DEFAULT 'normal',
        priority              VARCHAR(20)  DEFAULT 'normal',
        status                VARCHAR(30)  DEFAULT 'open',
        assigned_to           INT REFERENCES users(id) ON DELETE SET NULL,
        assigned_by           INT REFERENCES users(id) ON DELETE SET NULL,
        assigned_to_name      TEXT,
        assigned_to_email     VARCHAR(200),
        assigned_to_phone     VARCHAR(30),
        notify_channel        VARCHAR(10)  DEFAULT 'wa',
        notify_before_minutes INTEGER      DEFAULT 60,
        triage_tag            VARCHAR(10)  DEFAULT 'none',
        replied_at            TIMESTAMPTZ,
        notified_at           TIMESTAMPTZ,
        due_at                TIMESTAMPTZ,
        notes                 TEXT,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        completed_at          TIMESTAMPTZ
      )
    `);
    
    // Add columns to existing tables if needed (idempotent)
    const newColsMailTasks = [
      `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_name      TEXT`,
      `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_email     VARCHAR(200)`,
      `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_phone     VARCHAR(30)`,
      `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notify_channel        VARCHAR(10)  DEFAULT 'wa'`,
      `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notify_before_minutes INTEGER      DEFAULT 60`,
      `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS triage_tag            VARCHAR(10)  DEFAULT 'none'`,
      `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS replied_at            TIMESTAMPTZ`,
      `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notified_at           TIMESTAMPTZ`,
    ];
    for (const sql of newColsMailTasks) {
      await pool.query(sql).catch(() => {});
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mail_reply_tasks_status      ON mail_reply_tasks(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mail_reply_tasks_assigned_to ON mail_reply_tasks(assigned_to)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mail_reply_tasks_message_id  ON mail_reply_tasks(message_id)`).catch(() => {});
    console.log('[DB] ✅ mail_reply_tasks table, columns and indexes ensured.');

    // 3. Ensure call_logs.recording_file exists
    await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_file TEXT`);

    // 3a. Ensure PBX contacts exists before routes or call-list joins use it.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pbx_contacts (
        id           SERIAL PRIMARY KEY,
        phone        VARCHAR(50) UNIQUE NOT NULL,
        name         VARCHAR(150),
        company      VARCHAR(150),
        notes        TEXT,
        email        VARCHAR(254),
        mobile_phone VARCHAR(50),
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE pbx_contacts ADD COLUMN IF NOT EXISTS email VARCHAR(254)`).catch(() => {});
    await pool.query(`ALTER TABLE pbx_contacts ADD COLUMN IF NOT EXISTS mobile_phone VARCHAR(50)`).catch(() => {});
    console.log('[DB] pbx_contacts table ensured.');

    // 4. Alter call_logs.call_time to TIME if it is VARCHAR/character varying
    const callTimeTypeRes = await pool.query(`
      SELECT data_type 
      FROM information_schema.columns 
      WHERE table_name = 'call_logs' AND column_name = 'call_time'
    `);
    if (callTimeTypeRes.rows.length > 0 && callTimeTypeRes.rows[0].data_type !== 'time without time zone') {
      console.log('[DB] Migrating call_logs.call_time column type to TIME...');
      // Safe conversion using USING clause
      await pool.query(`
        ALTER TABLE call_logs 
        ALTER COLUMN call_time TYPE TIME 
        USING (
          CASE 
            WHEN call_time IS NULL OR trim(call_time::text) = '' OR call_time::text = '-' THEN NULL 
            WHEN trim(call_time::text) ~ '^\\d{1,2}:\\d{2}(:\\d{2})?$' THEN call_time::time
            ELSE NULL 
          END
        )
      `);
      console.log('[DB] ✅ Migrated call_logs.call_time column type to TIME.');
    }

    // 5. Ensure deduped call materialized view used by /api/calls exists.
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS call_logs_deduped AS
      SELECT DISTINCT ON (
        CASE
          WHEN raw_line IS NOT NULL AND trim(raw_line) <> ''
            THEN regexp_replace(trim(raw_line), '^\\d+\\s+', '')
          ELSE 'id:' || id::text
        END
      ) *
      FROM call_logs candidate
      WHERE NOT (
        candidate.raw_line ~ '\\sT\\s*$'
        AND EXISTS (
          SELECT 1
          FROM call_logs primary_leg
          WHERE primary_leg.id <> candidate.id
            AND primary_leg.raw_line ~ '\\sD\\s*$'
            AND primary_leg.call_date IS NOT DISTINCT FROM candidate.call_date
            AND COALESCE(primary_leg.trunk, '') = COALESCE(candidate.trunk, '')
            AND regexp_replace(COALESCE(primary_leg.caller, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(candidate.caller, ''), '[^0-9]', '', 'g')
            AND ABS(EXTRACT(EPOCH FROM (
              (primary_leg.call_date::timestamp + COALESCE(primary_leg.call_time, TIME '00:00:00')) -
              (candidate.call_date::timestamp + COALESCE(candidate.call_time, TIME '00:00:00'))
            ))) <= 90
        )
      )
      ORDER BY
        CASE
          WHEN raw_line IS NOT NULL AND trim(raw_line) <> ''
            THEN regexp_replace(trim(raw_line), '^\\d+\\s+', '')
          ELSE 'id:' || id::text
        END,
        created_at DESC,
        id DESC
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_deduped_id ON call_logs_deduped (id)`).catch(() => {});
    await pool.query(`REFRESH MATERIALIZED VIEW call_logs_deduped`).catch(err => {
      console.warn('[DB] call_logs_deduped refresh skipped:', err.message);
    });
    console.log('[DB] call_logs_deduped materialized view ensured.');

    console.log('[DB] ✅ Schema check complete: self-healing complete.');
  } catch (err) {
    console.error('[DB] ❌ Schema check failed:', err.message);
  }
}
const schemaReady = ensureSchema();


const app = express();

const PORT = process.env.PORT || 8088;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 = LAN; 127.0.0.1 = local only

let server;
let urlScheme = 'http';
const sslKey = process.env.SSL_KEY_PATH;
const sslCert = process.env.SSL_CERT_PATH;
if (sslKey && sslCert) {
  const keyPath = path.isAbsolute(sslKey) ? sslKey : path.join(__dirname, sslKey);
  const certPath = path.isAbsolute(sslCert) ? sslCert : path.join(__dirname, sslCert);
  server = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }, app);
  urlScheme = 'https';
  console.log('[Server] Listening with TLS (HTTPS)');
} else {
  server = http.createServer(app);
}

// Force UTF-8 on JSON responses so emoji / Unicode round-trips without mojibake
app.use((_req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = function (body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return sendJson(body);
  };
  next();
});
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/socket.io'
});

// Inject Socket.IO into WhatsApp service for real-time push
wa.setIO(io);
smdr.setIO(io);

// Initialize activity log with DB persistence (load previous events)
activityLog.init(pool).catch(err => console.warn('[ActivityLog] Init error:', err.message));

// ── SYSTEM BRIDGE & PROBES ─────────────────────────────────────────────────

function _now() { return new Date().toISOString(); }

function markOnline(service) {
  serviceState[service].status = 'online';
  serviceState[service].lastConnected = _now();
  const ev = activityLog.append({ type: 'online', service, message: `${service} connected`, timestamp: _now() });
  try { _origEmit('system:service_online', { service, timestamp: ev.timestamp, seq: ev.seq }); } catch (_) { }
  try { _origEmit('system:activity', ev); } catch (_) { }
}

function markOffline(service, reason) {
  serviceState[service].status = 'offline';
  serviceState[service].lastDisconnected = _now();
  const msg = reason ? `${service} disconnected: ${reason}` : `${service} disconnected`;
  const ev = activityLog.append({ type: 'offline', service, message: msg, timestamp: _now() });
  try { _origEmit('system:service_offline', { service, timestamp: ev.timestamp, reason: reason || 'Connection lost', seq: ev.seq }); } catch (_) { }
  try { _origEmit('system:activity', ev); } catch (_) { }
}

function markPbxListening(data) {
  serviceState.pbx.status = 'connected';
  serviceState.pbx.port = data?.port || SMDR_PORT;
  serviceState.pbx.mode = data?.mode || 'server';
  serviceState.pbx.clientHost = process.env.PBX_HOST || serviceState.pbx.clientHost || null;
  const ev = activityLog.append({
    type: 'info',
    service: 'pbx',
    message: `Matrix PBX reachable; SMDR listener active on port ${serviceState.pbx.port}`,
    timestamp: _now(),
  });
  try { _origEmit('system:activity', ev); } catch (_) { }
}

function systemBridge(event, data) {
  try {
    if (String(event || '').startsWith('pbx:')) {
      console.log('[SYSTEM-BRIDGE][PBX] Event received', {
        event,
        data,
        stateBefore: { ...serviceState.pbx },
      });
    }
    // ── Service connect/disconnect ──────────────────────────────────────
    if (event === 'wa:connected') {
      markOnline('whatsapp');
      const raw = data?.phone || data?.jid || null;
      serviceState.whatsapp.phone = raw ? String(raw).split('@')[0].split(':')[0].replace(/\D/g, '') || null : null;
    }
    else if (event === 'wa:disconnected') {
      markOffline('whatsapp', data?.reason || (data?.code ? `code ${data.code}` : null));
      serviceState.whatsapp.phone = null;
    }
    else if (event === 'pbx:listening') {
      // Server is listening but no PBX connected yet
      markPbxListening(data);
    }
    else if (event === 'pbx:connected') {
      // Actual PBX socket connected
      markOnline('pbx');
      serviceState.pbx.clientHost = data?.ip || data?.host || null;
      serviceState.pbx.status = 'connected';
      serviceState.pbx.connectedAt = data?.connectedAt || Date.now();
    }
    else if (event === 'pbx:ready') {
      // Legacy event — treat as listening
      markPbxListening(data);
    }
    else if (event === 'pbx:disconnected') {
      serviceState.pbx.status = data?.fatal ? 'offline' : 'connected';
      serviceState.pbx.clientHost = data?.fatal ? null : (process.env.PBX_HOST || serviceState.pbx.clientHost || null);
      if (data?.fatal) {
        markOffline('pbx', data.error || data.reason);
      } else {
        // Non-fatal disconnect — server still listening
        const ev = activityLog.append({
          type: 'info',
          service: 'pbx',
          message: `PBX disconnected: ${data?.reason || 'Connection lost'} — listening for reconnection`,
          timestamp: _now()
        });
        try { _origEmit('system:activity', ev); } catch (_) { }
      }
    }

    // ── WhatsApp activity ───────────────────────────────────────────────
    else if (event === 'wa:message') {
      const who = data?.fromMe ? 'You' : (data?.senderName || data?.chatId || 'Unknown');
      const chat = data?.chatName || data?.chatId || '';
      const body = (data?.body || '').slice(0, 60);
      const msg = data?.fromMe
        ? `WA sent to ${chat}: ${body}`
        : `WA received from ${who} (${chat}): ${body}`;
      activityLog.append({ type: 'info', service: 'whatsapp', message: msg, timestamp: _now() });
    }
    else if (event === 'wa:sync_complete') {
      activityLog.append({ type: 'info', service: 'whatsapp', message: 'WhatsApp history sync complete', timestamp: _now() });
    }
    else if (event === 'wa:qr') {
      activityLog.append({ type: 'info', service: 'whatsapp', message: 'WhatsApp QR code generated — waiting for scan', timestamp: _now() });
    }

    // ── PBX call ────────────────────────────────────────────────────────
    else if (event === 'pbx:call') {
      const d = data || {};
      const type = d.call_type || 'Call';
      const caller = d.caller || '?';
      const dest = d.destination || d.extension || '?';
      const dur = d.duration || '';
      activityLog.append({
        type: 'info', service: 'pbx',
        message: `PBX ${type}: ${caller} → ${dest}${dur ? ' (' + dur + ')' : ''}`,
        timestamp: _now(),
      });
    }

    // ── Outlook mail sync ───────────────────────────────────────────────
    else if (event === 'outlook:mail_synced') {
      const count = data?.count || 0;
      activityLog.append({ type: 'info', service: 'outlook', message: `Outlook synced ${count} new mail(s)`, timestamp: _now() });
    }
    else if (event === 'outlook:unread_update') {
      activityLog.append({ type: 'info', service: 'outlook', message: `Outlook unread: ${data?.unread ?? '?'}`, timestamp: _now() });
    }

    // ── Marketing cron ──────────────────────────────────────────────────
    else if (event === 'marketing:sync_reminder') {
      activityLog.append({ type: 'info', service: 'system', message: `Marketing reminder: ${data?.message || 'Time to sync EngageBay stats'}`, timestamp: _now() });
    }

    // ── User login (emitted from auth route) ────────────────────────────
    else if (event === 'system:user_login') {
      const user = data?.name || data?.email || 'Unknown user';
      activityLog.append({ type: 'user_login', service: 'system', message: `User logged in: ${user}`, timestamp: _now() });
      try { _origEmit('system:activity', { type: 'user_login', service: 'system', message: `User logged in: ${user}`, timestamp: _now() }); } catch (_) { }
    }
    else if (event === 'system:user_logout') {
      const user = data?.name || data?.email || 'Unknown user';
      activityLog.append({ type: 'user_login', service: 'system', message: `User logged out: ${user}`, timestamp: _now() });
    }

    // ── Emit generic activity event for all non-connect/disconnect events ─
    if (!['wa:connected', 'wa:disconnected', 'pbx:connected', 'pbx:disconnected', 'pbx:listening', 'pbx:ready'].includes(event)) {
      const last = activityLog.getRecent(1)[0];
      if (last) {
        try { _origEmit('system:activity', last); } catch (_) { }
      }
    }

    if (String(event || '').startsWith('pbx:')) {
      console.log('[SYSTEM-BRIDGE][PBX] State after event', {
        event,
        stateAfter: serviceState.pbx,
      });
    }
  } catch (err) {
    console.error('[SystemBridge] Error:', err.message);
  }
}

// Wrap io.emit to intercept wa:* and pbx:* events for the system bridge
const _origEmit = io.emit.bind(io);
io.emit = function (event, ...args) {
  _origEmit(event, ...args);
  systemBridge(event, args[0]);
};

// Send activity log snapshot to newly connected Socket.IO clients
io.on('connection', (socket) => {
  socket.emit('system:log_snapshot', { events: activityLog.getRecent(100) });

  socket.on('pbx:reconnect', () => {
    const traceId = `PBX-RECONNECT-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    console.log(`[${traceId}] Socket.IO pbx:reconnect received`, {
      socketId: socket.id,
      clientAddress: socket.handshake.address,
      userAgent: socket.handshake.headers['user-agent'],
      pbxStateBefore: serviceState.pbx,
      smdrStatusBefore: smdr.getStatus(),
    });
    Promise.resolve(smdr.reconnect())
      .then(() => console.log(`[${traceId}] smdr.reconnect() completed/queued`, {
        smdrStatusAfter: smdr.getStatus(),
      }))
      .catch(err => console.error(`[${traceId}] smdr.reconnect() failed`, {
        message: err.message,
        stack: err.stack,
      }));
  });
});

// PostgreSQL pool error → mark offline
pool.on('error', (err) => {
  if (serviceState.postgres.status !== 'offline') {
    markOffline('postgres', err.message);
  }
});

// Periodic probes
const outlookProbeMs = parseInt(process.env.OUTLOOK_PROBE_INTERVAL_MS, 10) || 60000;
const dbProbeMs = parseInt(process.env.DB_PROBE_INTERVAL_MS, 10) || 30000;

async function probeOutlook() {
  try {
    // Check if user has a valid delegated token (not client credentials)
    const stored = await require('./db/pool').query(
      `SELECT access_token, refresh_token, expires_at FROM ms_tokens WHERE user_email = $1`,
      [process.env.MS_USER_EMAIL]
    ).catch(() => ({ rows: [] }));

    const row = stored.rows && stored.rows[0];
    if (!row || (!row.access_token && !row.refresh_token)) {
      // No delegated token at all — needs full re-auth
      if (serviceState.outlook.status !== 'offline') {
        markOffline('outlook', 'No token — full re-authentication required (MFA may be needed)');
      }
      return;
    }

    // Token exists — verify it actually works with a real Graph call
    const auth = await msGraph.isAuthenticated();
    if (auth) {
      if (serviceState.outlook.status !== 'online') markOnline('outlook');
    } else {
      // Token exists but rejected — likely expired, can re-auth without MFA
      if (serviceState.outlook.status !== 'offline') {
        markOffline('outlook', 'Token expired — click Connect Outlook to re-authenticate (no MFA needed)');
      }
    }
  } catch (err) {
    console.error('[System] Outlook probe error:', err.message);
    if (serviceState.outlook.status !== 'offline') {
      markOffline('outlook', `Outlook probe error: ${err.message}`);
    }
  }
}

async function probePostgres() {
  try {
    await pool.query('SELECT 1');
    if (serviceState.postgres.status !== 'online') markOnline('postgres');
  } catch (err) {
    if (serviceState.postgres.status !== 'offline') markOffline('postgres', err.message);
  }
}

// Run initial probes after 3s (give server time to fully start)
setTimeout(() => { probeOutlook(); probePostgres(); }, 3000);

// ── Token keepalive — refresh token every 6h to prevent expiry ────────────
// Microsoft refresh tokens expire after 90 days of inactivity.
// This lightweight call every 6h keeps the token alive indefinitely.
const tokenKeepaliveMs = parseInt(process.env.TOKEN_KEEPALIVE_MS, 10) || (6 * 60 * 60 * 1000); // 6 hours
setInterval(async () => {
  try {
    const token = await msGraph.getAccessToken(process.env.MS_USER_EMAIL);
    if (token) {
      console.log('[System] ✅ Outlook token keepalive — token refreshed');
      activityLog.append({ type: 'info', service: 'outlook', message: 'Outlook token keepalive — token refreshed successfully', timestamp: new Date().toISOString() });
    }
  } catch (err) {
    console.warn('[System] Token keepalive failed:', err.message);
  }
}, tokenKeepaliveMs);

// Outlook probe
setInterval(probeOutlook, outlookProbeMs);

// PostgreSQL probe
setInterval(probePostgres, dbProbeMs);

// ── SERVE STATIC HTML FILES — after socket.io path is registered ──────────
app.use(express.static(path.join(__dirname, '..'), {
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
    } else if (ext === '.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=UTF-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    } else if (ext === '.css') {
      res.setHeader('Content-Type', 'text/css; charset=UTF-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    } else if (ext === '.json') {
      res.setHeader('Content-Type', 'application/json; charset=UTF-8');
    }
  },
}));

const pbxLocalRecordingsDir = process.env.PBX_LOCAL_RECORDINGS_DIR || path.join(__dirname, 'pbx_recordings');
app.use(
  '/pbx-local-recordings',
  express.static(pbxLocalRecordingsDir)
);

// Redirect root → login page
app.get('/', (_req, res) => {
  res.redirect('/login.html');
});

// Serve blank favicon to avoid console 404 errors
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── CORS ───────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    // Allow same-origin requests (served by this server) and local dev
    const allowed = [
      'http://localhost:4551',
      'http://127.0.0.1:4551',
      'http://192.168.0.149:4551',
      'http://localhost:8088',
      'http://127.0.0.1:8088',
      'https://localhost:8088',
      'https://127.0.0.1:8088',
      'http://192.168.0.149:8088',
      'https://192.168.0.149:8088',
      'http://192.168.0.200:8088',
      'https://192.168.0.200:8088',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'null', // For file:// protocol
    ];
    // Allow requests with no origin (same-server, mobile apps, curl)
    if (!origin || allowed.includes(origin)) return callback(null, true);
    callback(null, true); // Allow all origins in dev — restrict in production
  },
  credentials: true,
}));

// ── COMPRESSION ────────────────────────────────────────────────────────────
// Gzip all JSON API responses and HTML. Cuts chat list payload ~70%.
// Socket.IO handles its own framing — compression won't interfere.
const compression = require('compression');
app.use(compression({ threshold: 1024 })); // only compress responses > 1KB

// ── BODY PARSING ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// ── INPUT VALIDATION (Security) ────────────────────────────────────────────
const { validateInput } = require('./middleware/inputValidation');
// Apply to all API routes (skip static files and auth callback)
app.use((req, res, next) => {

  // Skip validation for Outlook backup APIs
  if (
    req.path.includes('/outlook-backups/create') ||
    req.path.includes('/outlook-backups/restore')
  ) {
    return next();
  }

  validateInput(req, res, next);

});

// ── DEBUG ROUTE (PRIORITY) ──
app.get('/debug-messages', async (req, res) => {
  try {
    const connectedPhone = wa.getConnectedPhone();
    const result = await pool.query('SELECT chat_id, from_me, body, timestamp FROM wa_messages ORDER BY timestamp DESC LIMIT 15');
    res.json({
      instance_connected_as: connectedPhone || 'NOT CONNECTED',
      latest_messages: result.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(cors());
// ── RATE LIMITING ──────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 20,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 min
  max: 600,                   // raised — dashboard makes ~8 calls on load
  message: { error: 'Rate limit exceeded.' },
  skip: (req) => {
    // never rate-limit the sync endpoint — it's a long-running manual action
    return req.path.includes('sync-messages') || req.path.includes('sync-stats');
  },
});

// ── ROUTES ─────────────────────────────────────────────────────────────────
app.use('/api/auth/login', authLimiter);
app.use('/api/auth', apiLimiter, require('./routes/auth'));
app.use('/api/contacts', apiLimiter, require('./routes/contacts'));
app.use('/api/pipeline', apiLimiter, require('./routes/pipeline'));
app.use('/api/calls', apiLimiter, require('./routes/calls'));
app.use('/api/campaigns', apiLimiter, require('./routes/campaigns'));
app.use('/api/dashboard', apiLimiter, require('./routes/dashboard'));
app.use('/api/outlook', apiLimiter, require('./routes/outlook'));
app.use('/api/wa', apiLimiter, require('./routes/whatsapp'));
app.use('/api/eb', apiLimiter, require('./routes/engagebay'));
app.use('/api/marketing', apiLimiter, require('./routes/marketing'));
app.use('/api/broadcast', apiLimiter, require('./routes/broadcast'));
app.use('/api/templates', apiLimiter, require('./routes/emailTemplates'));
app.use('/api/marquee', require('./routes/marquee'));
app.use('/api/groups', apiLimiter, require('./routes/recipientGroups'));
app.use('/api/mail-tasks', apiLimiter, require('./routes/mailTasks'));
app.use('/api/system', apiLimiter, require('./routes/system'));
app.use('/api/outlook-backups', apiLimiter, require('./routes/outlookBackups'));
app.use('/api/matrix-backup', require('./routes/matrixBackup'));
app.use('/api/pbx', require('./routes/pbx'));
app.use('/api/crm', require('./routes/crmIntegration'));

// OAuth2 callback - must be at root level to match redirect URI
app.use('/auth', require('./routes/outlook'));

// -- HEALTH CHECK -----------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'UniComm Pro API', version: '3.0.0', timestamp: new Date().toISOString() });
});

// -- 404 --------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `${req.method} ${req.path} not found.` });
});

// -- GLOBAL ERROR HANDLER ---------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// -- START ------------------------------------------------------------------
server.listen(PORT, HOST, async () => {
  console.log(`\nUniComm Pro API  ->  ${urlScheme}://localhost:${PORT}  (bind ${HOST})`);
  console.log(`Health check     ->  ${urlScheme}://localhost:${PORT}/api/health`);
  console.log(`📱  WhatsApp        →  starting...\n`);

  // Sequential Service Initialization for stability
  try {
    console.log('[System] Initializing services...');

    // Background services query these tables immediately; wait for self-healing
    // schema setup so a fresh tower database does not spam relation errors.
    await schemaReady;

    // 1. Matrix SMDR listener (Critical for call logging)
    await smdr.start().catch(err => console.error('[SMDR] Start error:', err.message));

    // 2. WhatsApp — auto-reconnects, QR pushed via Socket.IO
    await wa.startWA().catch(err => console.error('[WA] Start error:', err.message));

    // 3. AI System Initialization (Ensure tables)
    aiTaskQueue.init(io);
    await aiTaskQueue.ensureTable();

    // 4. Maintenance & Schedulers
    mktCron.start(io);
    oneDriveSync.start();
    waInventory.startDailyBackup(() => wa.getConnectedPhone());
    taskNotifier.start(pool);

    console.log('[System] ✅ All background services initialized.');
  } catch (err) {
    console.error('[System] ❌ Critical initialization failure:', err.message);
  }

  // ✅ 2. START DAILY PRUNING (7-day policy)
  cron.schedule('0 0 * * *', async () => {
    console.log('[Maintenance] Running daily AI task history pruning (7-day policy)...');
    try {
      await aiTaskQueue.pruneHistory(7);
      await maintenance.pruneAntigravityLogs();
    } catch (err) {
      console.error('[Maintenance] Cron error:', err.message);
    }
  });

  // Run initial maintenance on startup (async)
  maintenance.pruneAntigravityLogs().catch(err => console.error('[Maintenance] Startup pruning failed:', err.message));
});


// Preserve WhatsApp auth on server stop so restart can reconnect silently.
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down - preserving WA session for stable reconnect.');
  process.exit(0);
});
