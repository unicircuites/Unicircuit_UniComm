/**
 * Microsoft Graph API Service
 * Handles OAuth2 token management and Graph API calls
 * for sales@unicircuites.com mailbox
 */
const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const pool  = require('../db/pool');

const GRAPH = 'https://graph.microsoft.com/v1.0';

function msAuthority() {
  const tid = (process.env.MS_TENANT_ID || '').trim().toLowerCase();
  if (tid === 'common' || tid === 'organizations') {
    return `https://login.microsoftonline.com/${tid}`;
  }
  if (tid) {
    return `https://login.microsoftonline.com/${tid}`;
  }
  return 'https://login.microsoftonline.com/common';
}

// ── MSAL Confidential Client ───────────────────────────────────────────────
const msalConfig = {
  auth: {
    clientId:     process.env.MS_CLIENT_ID,
    authority:    msAuthority(),
    clientSecret: process.env.MS_CLIENT_SECRET,
  },
  system: {
    loggerOptions: {
      loggerCallback(level, message) {
        console.log(`[MSAL][${level}] ${message}`);
      },
      piiLoggingEnabled: false,
      logLevel: 3, // Info
    }
  }
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
async function getAuthUrl(state) {
  const authority = msAuthority();
  console.log('\n[Outlook OAuth] getAuthUrl() — values actually used this request:');
  console.log('  authority (tenant segment) =', authority);
  console.log('  MS_TENANT_ID (raw .env)     =', process.env.MS_TENANT_ID || '(empty)');
  console.log('  MS_CLIENT_ID                =', process.env.MS_CLIENT_ID || '(empty)');
  console.log('  MS_REDIRECT_URI             =', process.env.MS_REDIRECT_URI || '(empty)');
  console.log('  MS_USER_EMAIL (login_hint)  =', process.env.MS_USER_EMAIL || '(empty)');
  console.log('  client_secret in .env?      =', process.env.MS_CLIENT_SECRET ? `yes (${process.env.MS_CLIENT_SECRET.length} chars)` : 'NO — OAuth will fail');
  console.log('  scopes                      =', SCOPES.join(', '));

  try {
    const url = await cca.getAuthCodeUrl({
      scopes:      SCOPES,
      redirectUri: process.env.MS_REDIRECT_URI,
      loginHint:   process.env.MS_USER_EMAIL,
      state:       state || 'unicomm',
      prompt:      'select_account',
    });
    try {
      const u = new URL(url);
      console.log('  built URL (parsed):');
      console.log('    client_id     =', u.searchParams.get('client_id'));
      console.log('    redirect_uri  =', u.searchParams.get('redirect_uri'));
      console.log('    scope (head)  =', (u.searchParams.get('scope') || '').slice(0, 120) + '…');
    } catch (_) {
      console.log('  full URL (first 120 chars) =', url.slice(0, 120) + '…');
    }
    console.log('[Outlook OAuth] If Microsoft shows AADSTS700016: that CLIENT_ID is not registered in THIS tenant.');
    console.log('  Fix: In Azure → App registrations → your app → Overview → "Directory (tenant) ID" must match MS_TENANT_ID,');
    console.log('  OR create a new app registration inside that tenant and put its Application (client) ID in MS_CLIENT_ID.\n');
    return url;
  } catch (err) {
    console.error('[MSAL] getAuthCodeUrl failed:', err.message);
    console.error('[MSAL] errorCode:', err.errorCode, 'subError:', err.subError);
    throw err;
  }
}

/** Call once after dotenv (e.g. from server.js) — does not print secrets */
function logOutlookOAuthConfigAtStartup() {
  const tid = (process.env.MS_TENANT_ID || '').trim() || '(missing)';
  const cid = (process.env.MS_CLIENT_ID || '').trim() || '(missing)';
  const redir = (process.env.MS_REDIRECT_URI || '').trim() || '(missing)';
  const email = (process.env.MS_USER_EMAIL || '').trim() || '(missing)';
  const secretOk = !!(process.env.MS_CLIENT_SECRET && String(process.env.MS_CLIENT_SECRET).length > 8);
  console.log('\n── Microsoft Graph / Outlook (.env) ──────────────────────────────────');
  console.log('  MS_TENANT_ID     ', tid);
  console.log('  MS_CLIENT_ID     ', cid);
  console.log('  MS_REDIRECT_URI  ', redir);
  console.log('  MS_USER_EMAIL    ', email);
  console.log('  MS_CLIENT_SECRET ', secretOk ? '(set)' : '(MISSING or too short)');
  console.log('  computed authority:', msAuthority());
  console.log('  Tip: AADSTS700016 = app not in tenant. Directory (tenant) ID on the app');
  console.log('       registration in Azure must equal MS_TENANT_ID (or use a new app in that tenant).');
  console.log('────────────────────────────────────────────────────────────────────────\n');
}

// ── EXCHANGE CODE FOR TOKEN ────────────────────────────────────────────────
async function exchangeCode(code) {
  console.log('[MSAL] Exchanging auth code for token...');
  try {
    const result = await cca.acquireTokenByCode({
      code,
      scopes:      SCOPES,
      redirectUri: process.env.MS_REDIRECT_URI,
    });
    console.log('[MSAL] ✅ Token acquired for:', result.account?.username);
    const email = result.account?.username || process.env.MS_USER_EMAIL;
    await saveTokens(email, result);
    return { result, email };
  } catch (err) {
    console.error('[MSAL] ❌ exchangeCode failed:', err.message);
    console.error('[MSAL] Error code:', err.errorCode);
    console.error('[MSAL] Sub error:', err.errorMessage);
    throw err;
  }
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
  logOutlookOAuthConfigAtStartup,
};
