/**
 * Microsoft Graph API Service
 * Handles OAuth2 token management and Graph API calls
 * for sales@unicircuites.com mailbox
 */
const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const pool  = require('../db/pool');

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ── MSAL Confidential Client ───────────────────────────────────────────────
const msalConfig = {
  auth: {
    clientId:     process.env.MS_CLIENT_ID,
    authority:    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`,
    clientSecret: process.env.MS_CLIENT_SECRET,
  },
};

const cca = new msal.ConfidentialClientApplication(msalConfig);

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Contacts.Read',
  'offline_access',
];

// ── TOKEN STORAGE (PostgreSQL) ─────────────────────────────────────────────
async function ensureTokenTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ms_tokens (
      id            SERIAL PRIMARY KEY,
      user_email    VARCHAR(200) UNIQUE NOT NULL,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function saveTokens(email, tokenResponse) {
  await ensureTokenTable();
  const expiresAt = new Date(Date.now() + (tokenResponse.expiresIn || 3600) * 1000);
  await pool.query(`
    INSERT INTO ms_tokens (user_email, access_token, refresh_token, expires_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_email) DO UPDATE
      SET access_token  = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at    = EXCLUDED.expires_at,
          updated_at    = NOW()
  `, [email, tokenResponse.accessToken, tokenResponse.refreshToken || null, expiresAt]);
}

async function getStoredTokens(email) {
  await ensureTokenTable();
  const res = await pool.query(
    `SELECT * FROM ms_tokens WHERE user_email = $1`, [email]
  );
  return res.rows[0] || null;
}

// ── GET VALID ACCESS TOKEN ─────────────────────────────────────────────────
async function getAccessToken(email) {
  const stored = await getStoredTokens(email);

  // If we have a valid token (not expiring in next 5 min), use it
  if (stored && stored.access_token && stored.expires_at) {
    const expiresAt = new Date(stored.expires_at);
    if (expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
      return stored.access_token;
    }
  }

  // Try refresh token
  if (stored && stored.refresh_token) {
    try {
      const result = await cca.acquireTokenByRefreshToken({
        refreshToken: stored.refresh_token,
        scopes: SCOPES,
      });
      await saveTokens(email, result);
      return result.accessToken;
    } catch (err) {
      console.warn('[Graph] Refresh token failed:', err.message);
    }
  }

  return null; // Need re-auth
}

// ── BUILD AUTH URL ─────────────────────────────────────────────────────────
function getAuthUrl(state) {
  return cca.getAuthCodeUrl({
    scopes:      SCOPES,
    redirectUri: process.env.MS_REDIRECT_URI,
    loginHint:   process.env.MS_USER_EMAIL,
    state:       state || 'unicomm',
    prompt:      'select_account',
  });
}

// ── EXCHANGE CODE FOR TOKEN ────────────────────────────────────────────────
async function exchangeCode(code) {
  const result = await cca.acquireTokenByCode({
    code,
    scopes:      SCOPES,
    redirectUri: process.env.MS_REDIRECT_URI,
  });
  const email = result.account?.username || process.env.MS_USER_EMAIL;
  await saveTokens(email, result);
  return { result, email };
}

// ── GRAPH API HELPER ───────────────────────────────────────────────────────
async function graphGet(endpoint, email) {
  const token = await getAccessToken(email || process.env.MS_USER_EMAIL);
  if (!token) throw new Error('NOT_AUTHENTICATED');

  const res = await fetch(`${GRAPH}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Graph API error ${res.status}`);
  }
  return res.json();
}

async function graphPost(endpoint, body, email) {
  const token = await getAccessToken(email || process.env.MS_USER_EMAIL);
  if (!token) throw new Error('NOT_AUTHENTICATED');

  const res = await fetch(`${GRAPH}${endpoint}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Graph API error ${res.status}`);
  }
  // 202 / 204 = no body
  if (res.status === 202 || res.status === 204) return { success: true };
  return res.json();
}

async function graphPatch(endpoint, body, email) {
  const token = await getAccessToken(email || process.env.MS_USER_EMAIL);
  if (!token) throw new Error('NOT_AUTHENTICATED');

  const res = await fetch(`${GRAPH}${endpoint}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Graph API error ${res.status}`);
  }
  return res.json().catch(() => ({ success: true }));
}

// ── CHECK AUTH STATUS ──────────────────────────────────────────────────────
async function isAuthenticated(email) {
  try {
    const token = await getAccessToken(email || process.env.MS_USER_EMAIL);
    return !!token;
  } catch (_) {
    return false;
  }
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getAccessToken,
  graphGet,
  graphPost,
  graphPatch,
  isAuthenticated,
  saveTokens,
};
