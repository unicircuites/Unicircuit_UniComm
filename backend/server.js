/**
 * UniComm Pro — Express REST API
 * Unicircuit Engineering Services LLP
 *
 * Start:  node server.js
 * Dev:    nodemon server.js
 * Init DB: node db/init.js
 */
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 4551;

// ── SERVE STATIC HTML FILES (login.html, dashboard.html) ──────────────────
// Serves files from the project root (one level up from backend/)
app.use(express.static(path.join(__dirname, '..')));

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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

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
  max: 300,
  message: { error: 'Rate limit exceeded.' },
});

// ── ROUTES ─────────────────────────────────────────────────────────────────
app.use('/api/auth',      authLimiter, require('./routes/auth'));
app.use('/api/contacts',  apiLimiter,  require('./routes/contacts'));
app.use('/api/pipeline',  apiLimiter,  require('./routes/pipeline'));
app.use('/api/calls',     apiLimiter,  require('./routes/calls'));
app.use('/api/campaigns', apiLimiter,  require('./routes/campaigns'));
app.use('/api/dashboard', apiLimiter,  require('./routes/dashboard'));
app.use('/api/outlook',   apiLimiter,  require('./routes/outlook'));

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
app.listen(PORT, () => {
  console.log(`\n🚀  UniComm Pro API  →  http://localhost:${PORT}`);
  console.log(`🏥  Health check    →  http://localhost:${PORT}/api/health\n`);
});
