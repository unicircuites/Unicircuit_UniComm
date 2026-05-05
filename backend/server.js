/**
 * UniComm Pro — Express REST API
 * Unicircuit Engineering Services LLP
 *
 * Start:  node server.js
 * Dev:    nodemon server.js
 * Init DB: node db/init.js
 */
require('dotenv').config();
try {
  require('./services/msGraph').logOutlookOAuthConfigAtStartup();
} catch (e) {
  console.warn('[Outlook] Could not log OAuth env:', e.message);
}
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const rateLimit  = require('express-rate-limit');
const wa         = require('./services/whatsapp');
const smdr       = require('./services/matrixSmdr');
const mktCron    = require('./services/marketingCron');
const pool       = require('./db/pool');

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
    key:  fs.readFileSync(keyPath),
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
  cors: { origin: '*', methods: ['GET','POST'] },
  path: '/socket.io'
});

// Inject Socket.IO into WhatsApp service for real-time push
wa.setIO(io);
smdr.setIO(io);

// ── SERVE STATIC HTML FILES — after socket.io path is registered ──────────
app.use(express.static(path.join(__dirname, '..'), {
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    } else if (ext === '.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=UTF-8');
    } else if (ext === '.css') {
      res.setHeader('Content-Type', 'text/css; charset=UTF-8');
    } else if (ext === '.json') {
      res.setHeader('Content-Type', 'application/json; charset=UTF-8');
    }
  },
}));

// Redirect root → login page
app.get('/', (_req, res) => {
  res.redirect('/login.html');
});

// ── CORS ───────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
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
      'http://192.168.0.205:8088',
      'https://192.168.0.205:8088',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
    ];
    // Allow requests with no origin (same-server, mobile apps, curl)
    if (!origin || allowed.includes(origin)) return callback(null, true);
    callback(null, true); // Allow all origins in dev — restrict in production
  },
  credentials: true,
}));

// ── BODY PARSING ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

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
app.use('/api/auth',      authLimiter, require('./routes/auth'));
app.use('/api/contacts',  apiLimiter,  require('./routes/contacts'));
app.use('/api/pipeline',  apiLimiter,  require('./routes/pipeline'));
app.use('/api/calls',     apiLimiter,  require('./routes/calls'));
app.use('/api/campaigns', apiLimiter,  require('./routes/campaigns'));
app.use('/api/dashboard', apiLimiter,  require('./routes/dashboard'));
app.use('/api/outlook',   apiLimiter,  require('./routes/outlook'));
app.use('/api/wa',        apiLimiter,  require('./routes/whatsapp'));
app.use('/api/eb',        apiLimiter,  require('./routes/engagebay'));
app.use('/api/marketing', apiLimiter,  require('./routes/marketing'));
app.use('/api/broadcast', apiLimiter,  require('./routes/broadcast'));
app.use('/api/templates', apiLimiter,  require('./routes/emailTemplates'));
app.use('/api/marquee',  require('./routes/marquee')); // public — no auth, no rate limit

// OAuth2 callback — must be at root level to match redirect URI
app.use('/auth',          require('./routes/outlook'));

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'UniComm Pro API', version: '3.0.0', timestamp: new Date().toISOString() });
});

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `${req.method} ${req.path} not found.` });
});

// ── GLOBAL ERROR HANDLER ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── START ──────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`\n🚀  UniComm Pro API  →  ${urlScheme}://localhost:${PORT}  (bind ${HOST})`);
  console.log(`🏥  Health check    →  ${urlScheme}://localhost:${PORT}/api/health`);
  console.log(`📱  WhatsApp        →  starting...\n`);

  // Start WhatsApp — auto-reconnects, QR pushed via Socket.IO
  wa.startWA().catch(err => console.error('[WA] Start error:', err.message));

  // Start Matrix SMDR listener
  smdr.start().catch(err => console.error('[SMDR] Start error:', err.message));

  // Start Marketing cron (6 PM daily reminder)
  mktCron.start(io);
});

// Clear WhatsApp session on server stop so mobile shows disconnected
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down — clearing WA session...');
  try {
    const wa = require('./services/whatsapp');
    if (wa.getStatus().connected) {
      await wa.logout();
    }
  } catch(_) {}
  process.exit(0);
});
