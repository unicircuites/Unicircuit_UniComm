const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { chromium } = require('playwright');
const { renderUrlWithChrome } = require('../../chromeRenderer');
const {
  runDeepExtraction,
  runFieldDiscovery,
  heuristicToRecordTypes,
  heuristicDiscoverFromHeuristic,
} = require('../../extractDeepFieldsWithAI');

const activeSessions = new Map();

// ── ANTI-BOT / PERSISTENT PROFILE LAYER ─────────────────────────────────────
// Replaying a saved cookie blob (storageState) gives Facebook a half-authenticated
// session, so it bounces you back to login in an endless loop. Instead we use a
// REAL persistent Chrome profile on disk: you log in ONCE, the profile stays
// logged in across runs exactly like a normal browser — no re-login, no puzzle
// loop. Combined with stealth patches + the real installed Chrome, this is what
// stops the CAPTCHA escalation.
const SCRAPER_PROFILE_DIR = process.env.SCRAPER_PROFILE_DIR || path.join(__dirname, '..', '.scraper-chrome-profile');

const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--start-maximized',
];

const STEALTH_CONTEXT_OPTIONS = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
  viewport: { width: 1366, height: 900 },
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
};

// Patch away the most common automation tells before any page script runs.
function stealthInitScript() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
  const origQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (origQuery) {
    window.navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
  }
}

// Open a persistent, stealthed browser session. Returns a BrowserContext whose
// cookies/localStorage live in SCRAPER_PROFILE_DIR and survive across runs.
// Use context.close() to shut it down (there is no separate browser object).
async function openStealthSession(extra = {}) {
  const options = {
    headless: false,
    args: STEALTH_ARGS,
    ...STEALTH_CONTEXT_OPTIONS,
    ...extra,
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(SCRAPER_PROFILE_DIR, { channel: 'chrome', ...options });
  } catch (err) {
    console.warn(`[SCRAPER] Real Chrome unavailable (${err.message}); using bundled Chromium profile.`);
    context = await chromium.launchPersistentContext(SCRAPER_PROFILE_DIR, options);
  }
  try {
    await context.addInitScript(stealthInitScript);
  } catch (err) {
    console.warn(`[SCRAPER] Failed to apply stealth init script: ${err.message}`);
  }
  console.log(`[SCRAPER] Using persistent Chrome profile: ${SCRAPER_PROFILE_DIR}`);
  return context;
}
// ────────────────────────────────────────────────────────────────────────────

const MANUAL_LOGIN_TIMEOUT_MS = 300000; // 5 minutes for user to complete login

let loginWaitStatus = {
  active: false,
  phase: 'idle',
  message: '',
  remainingMs: 0,
  totalMs: MANUAL_LOGIN_TIMEOUT_MS,
  currentUrl: '',
  startedAt: null
};

function updateLoginWaitStatus(updates) {
  Object.assign(loginWaitStatus, updates);
}

function clearLoginWaitStatus() {
  loginWaitStatus = {
    active: false,
    phase: 'idle',
    message: '',
    remainingMs: 0,
    totalMs: MANUAL_LOGIN_TIMEOUT_MS,
    currentUrl: '',
    startedAt: null
  };
}

function getLoginWaitStatus() {
  const elapsed = loginWaitStatus.startedAt ? Date.now() - loginWaitStatus.startedAt : 0;
  const remainingMs = loginWaitStatus.active
    ? Math.max(0, loginWaitStatus.totalMs - elapsed)
    : loginWaitStatus.remainingMs;
  return { ...loginWaitStatus, remainingMs, elapsedMs: elapsed };
}

// Helper to detect 2-step verification, CAPTCHAs, robot challenge pages,
// OR any generic post-login popup/modal/overlay (start challenge, accept terms, surveys, etc.)
async function isVerificationOrRobotPage(page) {
  try {
    const url = page.url().toLowerCase();
    
    // Check URL patterns
    const verificationUrls = ['verify', 'verification', 'challenge', 'captcha', 'mfa', '2fa', 'otp', 'robot', 'security-check', 'cloudflare', 'turnstile', 'recaptcha'];
    if (verificationUrls.some(pattern => url.includes(pattern))) {
      return true;
    }
    
    // Check page text content for verification/challenge cues
    const bodyText = (await page.textContent('body') || '').toLowerCase();
    const verificationTexts = [
      'verification code', 'verify your identity', 'two-step verification', 
      'enter the code', 'sent a code', 'one-time password', 'security code',
      'i am not a robot', 'check your phone', 'confirm your phone', 'authenticator',
      'prove you are human', 'cloudflare', 'hcaptcha', 'recaptcha', 'robot',
      'verify you are human',
      // Generic post-login popups/challenges:
      'start new challenge', 'start a challenge', 'new challenge',
      'accept terms', 'terms and conditions', 'terms of service', 'agree to terms',
      'take a survey', 'complete your profile', 'finish setup',
      'get started', 'welcome to', 'setup your account',
      'before you continue', 'confirm your account',
      'update your information', 'additional verification'
    ];
    if (verificationTexts.some(text => bodyText.includes(text))) {
      return true;
    }
    
    // Check for common verification inputs or iframe selectors
    const hasOtpInput = await page.$('input[name*="code" i], input[id*="code" i], input[name*="otp" i], input[id*="otp" i], input[name*="token" i], input[id*="token" i], input[placeholder*="code" i]');
    const hasCaptchaElements = await page.$('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], div.cf-turnstile, div.g-recaptcha, iframe[src*="cloudflare" i]');
    if (hasOtpInput || hasCaptchaElements) {
      return true;
    }

    // Check for visible modal/overlay/dialog/popup elements (post-login challenges)
    const hasModal = await page.$(
      'div[role="dialog"], div[role="alertdialog"], ' +
      '[class*="modal" i][style*="display: block"], ' +
      '[class*="modal" i][style*="visibility: visible"], ' +
      '[class*="overlay" i][style*="display: block"], ' +
      '[class*="popup" i][style*="display: block"], ' +
      '[class*="challenge" i], ' +
      '[id*="challenge" i], ' +
      '[class*="dialog" i][style*="display: block"]'
    );
    if (hasModal) {
      // Only count it as a challenge if it has visible text content
      try {
        const modalText = await hasModal.textContent();
        if (modalText && modalText.trim().length > 10) {
          return true;
        }
      } catch (_) {}
    }
    
    return false;
  } catch (_) {
    return false;
  }
}

// Stricter check used during login polling — avoids false positives from site UI (e.g. Facebook dialogs).
async function isStrictVerificationPage(page) {
  try {
    const url = page.url().toLowerCase();
    const strictUrlPatterns = [
      '/checkpoint', '/two_step', '/two-factor', '/captcha', '/recaptcha',
      '/hcaptcha', '/security-check', '/mfa', '/otp', 'challenges.cloudflare.com'
    ];
    if (strictUrlPatterns.some((pattern) => url.includes(pattern))) {
      return true;
    }

    const bodyText = (await page.textContent('body') || '').toLowerCase();
    const strictTexts = [
      'verification code', 'verify your identity', 'two-step verification',
      'enter the code', 'sent a code', 'one-time password', 'security code',
      'i am not a robot', 'check your phone', 'confirm your phone', 'authenticator',
      'prove you are human', 'verify you are human', 'additional verification'
    ];
    if (strictTexts.some((text) => bodyText.includes(text))) {
      return true;
    }

    const hasOtpInput = await page.$(
      'input[name*="otp" i], input[id*="otp" i], input[name*="token" i], ' +
      'input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"]'
    );
    const hasCaptchaElements = await page.$(
      'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], div.cf-turnstile, ' +
      'div.g-recaptcha, iframe[src*="cloudflare" i]'
    );
    return !!(hasOtpInput || hasCaptchaElements);
  } catch (_) {
    return false;
  }
}

async function isVisiblePasswordField(page) {
  try {
    return page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="password"]');
      for (const input of inputs) {
        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        if (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          parseFloat(style.opacity || '1') > 0 &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          return true;
        }
      }
      return false;
    });
  } catch (_) {
    return false;
  }
}

function isLoginUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();

    if (host.includes('facebook.com') || host.includes('fb.com')) {
      return path.includes('/login') || path.includes('/checkpoint') || path.includes('/recover');
    }

    const loginPaths = ['/login', '/signin', '/sign-in', '/auth/login', '/account/login', '/oauth/authorize'];
    return loginPaths.some((segment) => path === segment || path.startsWith(`${segment}/`) || path.startsWith(`${segment}?`));
  } catch (_) {
    return false;
  }
}

async function hasSessionAuthCookies(context, hostname) {
  try {
    const cookies = await context.cookies();
    const host = (hostname || '').toLowerCase();

    if (host.includes('facebook.com') || host.includes('fb.com')) {
      const cUser = cookies.find((c) => c.name === 'c_user');
      const xs = cookies.find((c) => c.name === 'xs');
      return !!(cUser?.value && xs?.value);
    }

    const sessionHints = ['session', 'sessionid', 'sid', 'auth', 'token', 'logged_in', 'user_id'];
    return cookies.some((cookie) => {
      const name = cookie.name.toLowerCase();
      return cookie.value && sessionHints.some((hint) => name.includes(hint));
    });
  } catch (_) {
    return false;
  }
}

async function isManualLoginComplete(page, context, targetHostname) {
  const currentUrl = page.url();
  const visiblePassword = await isVisiblePasswordField(page);
  const onLoginPage = isLoginUrl(currentUrl);
  const hasAuthCookies = await hasSessionAuthCookies(context, targetHostname);
  const host = (targetHostname || '').toLowerCase();
  const isFacebook = host.includes('facebook.com') || host.includes('fb.com');

  if (isFacebook && hasAuthCookies && !onLoginPage) {
    console.log(`[SCRAPER] Facebook session cookies detected (c_user + xs). Login complete.`);
    return true;
  }

  if (hasAuthCookies && !visiblePassword && !onLoginPage) {
    console.log(`[SCRAPER] Auth cookies present and login form gone. Login complete.`);
    return true;
  }

  if (!visiblePassword && !onLoginPage) {
    const strictVerification = await isStrictVerificationPage(page);
    if (!strictVerification) {
      return true;
    }
  }

  return false;
}

async function waitForManualLogin(page, context, targetUrl, targetHostname) {
  const startTime = Date.now();
  let timeoutMs = MANUAL_LOGIN_TIMEOUT_MS;
  let verificationDetected = false;
  let consecutiveErrors = 0;

  updateLoginWaitStatus({
    active: true,
    phase: 'waiting_login',
    message: 'Please log in using the browser window. Waiting up to 5 minutes...',
    totalMs: timeoutMs,
    remainingMs: timeoutMs,
    currentUrl: page.url(),
    startedAt: startTime
  });

  while (Date.now() - startTime < timeoutMs) {
    const elapsed = Date.now() - startTime;
    const remainingMs = Math.max(0, timeoutMs - elapsed);
    updateLoginWaitStatus({
      phase: verificationDetected ? 'verification' : 'waiting_login',
      remainingMs,
      currentUrl: page.url(),
      message: verificationDetected
        ? `2-step verification detected — complete it in the browser (${Math.ceil(remainingMs / 1000)}s remaining)`
        : `Waiting for login in browser window (${Math.ceil(remainingMs / 1000)}s remaining)`
    });

    await sleep(1500);

    try {
      consecutiveErrors = 0;
      const currentUrl = page.url();
      const isVerification = await isStrictVerificationPage(page);

      if (isVerification && !verificationDetected) {
        console.log(`[SCRAPER] 2-step verification or CAPTCHA detected on: ${currentUrl}`);
        console.log(`[SCRAPER] Extending manual login window by 3 minutes...`);
        timeoutMs = Math.max(timeoutMs, elapsed + 180000);
        verificationDetected = true;
        updateLoginWaitStatus({
          phase: 'verification',
          totalMs: timeoutMs,
          message: '2-step verification detected — complete it in the browser (extended wait)'
        });
      }

      if (await isManualLoginComplete(page, context, targetHostname)) {
        updateLoginWaitStatus({
          phase: 'confirming',
          message: 'Login detected — confirming session...',
          remainingMs: Math.max(0, timeoutMs - (Date.now() - startTime))
        });
        console.log(`[SCRAPER] Login signal detected at: ${currentUrl}. Confirming in 2.5s...`);
        await sleep(2500);

        if (await isManualLoginComplete(page, context, targetHostname)) {
          const finalUrl = page.url();
          console.log(`[SCRAPER] Login confirmed! Landed on: ${finalUrl}`);
          updateLoginWaitStatus({
            phase: 'confirmed',
            message: 'Login successful — capturing session...',
            currentUrl: finalUrl,
            remainingMs: Math.max(0, timeoutMs - (Date.now() - startTime))
          });
          return true;
        }
      }
    } catch (pageErr) {
      consecutiveErrors++;
      // For a persistent context, context.browser() is null — detect a closed
      // browser via the page instead so we don't false-positive "browser closed".
      const browserGone = page.isClosed();
      if (browserGone || consecutiveErrors >= 8) {
        console.warn(`[SCRAPER WARNING] ${browserGone ? 'Browser closed by user' : '8 consecutive poll errors'}. Stopping login poll.`);
        break;
      }
      console.warn(`[SCRAPER] Transient navigation error #${consecutiveErrors} (retrying in 2s): ${pageErr.message}`);
      await sleep(2000);
    }
  }

  return false;
}

// Helper to simulate buffer/reload delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to parse cookies from string or array
function parseCookies(cookiesInput) {
  if (!cookiesInput) return [];
  if (Array.isArray(cookiesInput)) return cookiesInput;
  if (typeof cookiesInput === 'string') {
    try {
      const parsed = JSON.parse(cookiesInput.trim());
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'object' && parsed !== null) return [parsed];
    } catch (_) {}
  }
  return [];
}

function isFacebookHost(hostname) {
  const host = (hostname || '').toLowerCase();
  return host.includes('facebook.com') || host.includes('fb.com');
}

function getFacebookAboutUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, '');
    // Force English rendering so labels ("Followers", "About", "Contact info")
    // are in English for the keyword heuristics.
    parsed.searchParams.set('locale', 'en_US');
    const query = parsed.searchParams.toString();
    if (path.endsWith('/about')) return parsed.toString();
    return `${parsed.origin}${path}/about?${query}`;
  } catch (_) {
    return url;
  }
}

// Scroll the page down in steps, waiting after EACH scroll so lazy-loaded /
// infinite-scroll content (like Facebook) has time to render before we capture.
async function autoScrollForLazyContent(page, { maxSteps = 15, stepPx = 900, delayMs = 1500 } = {}) {
  let lastHeight = 0;
  let stableCount = 0;
  for (let i = 0; i < maxSteps; i++) {
    const atBottom = await page.evaluate((y) => {
      window.scrollBy(0, y);
      return (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 8);
    }, stepPx).catch(() => true);

    // Wait for network to settle, then a fixed delay for content to paint.
    await page.waitForLoadState('networkidle', { timeout: delayMs + 3000 }).catch(() => {});
    await sleep(delayMs);

    const height = await page.evaluate(() => document.body.scrollHeight).catch(() => lastHeight);
    // Stop once we're at the bottom and the page height hasn't grown twice in a row.
    if (atBottom && height <= lastHeight) {
      if (++stableCount >= 2) break;
    } else {
      stableCount = 0;
    }
    lastHeight = height;
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(600);
}

async function waitForDynamicContent(page, hostname) {
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await sleep(2000);

  await autoScrollForLazyContent(page);

  if (isFacebookHost(hostname)) {
    await page.waitForSelector('[role="main"], meta[property="og:title"]', { timeout: 15000 }).catch(() => {});
    await sleep(1000);
  }
}

async function extractFacebookProfileFields(page) {
  return page.evaluate(() => {
    const data = {};
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    // Normalise Devanagari (०-९) and Arabic-Indic digits to ASCII so counts match
    // even when Facebook renders the page in a non-English locale.
    const toAsciiDigits = (str) => (str || '').replace(/[०-९٠-٩]/g, (d) => {
      const code = d.charCodeAt(0);
      return String(code >= 0x0966 ? code - 0x0966 : code - 0x0660);
    });
    // Facebook wraps outbound links as l.facebook.com/l.php?u=<encoded real url>.
    const unwrapFbLink = (href) => {
      try {
        const u = new URL(href, location.origin);
        if (u.hostname.includes('facebook.com') && u.pathname.includes('/l.php')) {
          const real = u.searchParams.get('u');
          if (real) return decodeURIComponent(real);
        }
      } catch (_) {}
      return href;
    };
    // Strip Facebook chrome from the page name: leading "(9) " notification count
    // and trailing " | Facebook".
    const cleanName = (n) => clean(String(n || '').replace(/^\(\d+\)\s*/, '').split('|')[0].split(' - ')[0]);

    // Field names follow the UNICIRCUIT_MEDIA_DATA_FIELDS spec (FACEBOOK sheet →
    // PAGE / COMPANY PROFILE FIELDS).
    const metaContent = (sel) => {
      const m = document.querySelector(sel);
      return m ? clean(m.getAttribute('content') || '') : '';
    };

    // Open Graph tags
    const ogTitle = metaContent('meta[property="og:title"]');
    const ogDesc = metaContent('meta[property="og:description"]');
    const ogUrl = metaContent('meta[property="og:url"]');
    const ogImage = metaContent('meta[property="og:image"]');
    if (ogTitle) data.page_og_title = ogTitle;
    if (ogDesc) data.page_og_description = ogDesc;
    if (ogImage) data.page_og_image_url = ogImage;

    // page_name — prefer <h1>, fall back to og:title / <title>, strip "(9)" count.
    let name = cleanName(ogTitle) || cleanName(document.title);
    const h1 = document.querySelector('[role="main"] h1, h1');
    if (h1 && clean(h1.textContent)) name = cleanName(h1.textContent);
    if (name) data.page_name = name;

    if (ogDesc) data.page_description = ogDesc;

    // page_url + page_username (URL slug)
    const canonical = ogUrl || (document.querySelector('link[rel="canonical"]') || {}).href || location.href;
    if (canonical) {
      data.page_url = canonical;
      try {
        const seg = new URL(canonical).pathname.split('/').filter(Boolean);
        if (seg[0] && seg[0] !== 'profile.php' && !/^\d+$/.test(seg[0])) data.page_username = seg[0];
      } catch (_) {}
    }

    // page_id — from app-link metas or embedded config.
    const alUrl = metaContent('meta[property="al:android:url"]') || metaContent('meta[property="al:ios:url"]');
    let idMatch = alUrl.match(/(?:page|profile)\/?\??(?:id=)?(\d{5,})/i);
    if (!idMatch) idMatch = (document.documentElement.innerHTML || '').match(/"pageID":"(\d+)"|"page_id":"?(\d+)"?|"delegate_page":\{"id":"(\d+)"/);
    if (idMatch) data.page_id = idMatch[1] || idMatch[2] || idMatch[3];

    // page_verified — blue badge.
    if (document.querySelector('[aria-label*="Verified" i], svg[aria-label*="Verified" i], [title="Verified account"]')) {
      data.page_verified = 'Yes';
    }

    // Profile & cover images.
    const cover = document.querySelector('img[data-imgperflogname*="cover" i], img[alt*="cover photo" i]');
    if (cover && cover.src) data.page_cover_image_url = cover.src;
    if (name) {
      const nameHead = name.split(' ')[0];
      const profileImg = Array.from(document.querySelectorAll('img[src]')).find((im) => (im.getAttribute('alt') || '').includes(nameHead));
      if (profileImg) data.page_profile_image_url = profileImg.src;
    }

    const main = document.querySelector('[role="main"]') || document.body;
    const bodyText = toAsciiDigits(clean(main.innerText || ''));
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3,4}[-.\s]?\d{4,}/;

    // Counts (English labels — page loads with locale=en_US; Devanagari digits normalised).
    const followerMatch = bodyText.match(/([\d,.]+[KMB]?)\s+followers?/i);
    if (followerMatch) data.page_followers_count = followerMatch[1];
    const likeMatch = bodyText.match(/([\d,.]+[KMB]?)\s+likes?/i);
    if (likeMatch) data.page_likes_count = likeMatch[1];
    const checkinMatch = bodyText.match(/([\d,.]+[KMB]?)\s+(?:were here|check-?ins?)/i);
    if (checkinMatch) data.page_checkins_count = checkinMatch[1];

    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const link of links) {
      const rawHref = link.getAttribute('href') || '';
      const href = unwrapFbLink(rawHref);
      if (!data.page_email && rawHref.startsWith('mailto:')) {
        data.page_email = rawHref.replace('mailto:', '').split('?')[0];
      }
      if (!data.page_phone && rawHref.startsWith('tel:')) {
        data.page_phone = rawHref.replace('tel:', '').trim();
      }
      // page_website — external link after unwrapping FB's redirect, excluding FB hosts.
      if (
        !data.page_website &&
        /^https?:\/\//i.test(href) &&
        !/(?:^|\.)facebook\.com/i.test(href) &&
        !/(?:^|\.)fb\.com/i.test(href) &&
        !/fbcdn\.net|messenger\.com/i.test(href)
      ) {
        data.page_website = href;
      }
      // page_category — links point at /pages/category/…
      if (!data.page_category) {
        const label = clean(link.textContent);
        if (/\/pages\/category\//i.test(rawHref) && label && label.length < 60) {
          data.page_category = label;
        }
      }
    }

    const listItems = Array.from(main.querySelectorAll('[role="listitem"], li, div[data-pagelet]'));
    const seenValues = new Set();
    const isEventish = (t) => /\bevent\b|\bpast\b|going\b|interested\b|\d{1,2}:\d{2}\s*(am|pm)/i.test(t);
    let bestAddress = '';
    for (const item of listItems) {
      const text = toAsciiDigits(clean(item.innerText || ''));
      if (!text || text.length > 600 || seenValues.has(text)) continue;
      seenValues.add(text);

      const lower = text.toLowerCase();
      if (!data.page_email && emailRegex.test(text)) {
        const match = text.match(emailRegex);
        if (match) data.page_email = match[0];
      }
      if (!data.page_phone && phoneRegex.test(text)) {
        const match = text.match(phoneRegex);
        if (match) {
          const digits = match[0].replace(/\D/g, '');
          if (digits.length >= 7 && digits.length <= 15) data.page_phone = match[0];
        }
      }
      if (
        !data.page_website &&
        /\.(com|in|org|net|co)\b/i.test(text) &&
        !text.includes('facebook.com')
      ) {
        const urlMatch = text.match(/https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9-]+\.(?:com|in|org|net|co)(?:\.[a-z]{2})?/i);
        if (urlMatch) data.page_website = urlMatch[0];
      }
      // Address: prefer a PIN-code bearing, non-event line; keep the shortest match.
      const hasPin = /\b\d{6}\b/.test(text);
      const looksAddress = lower.startsWith('address') || hasPin || /\b(?:street|road|marg|nagar|plot no|opp\.)\b/i.test(text);
      if (looksAddress && !isEventish(text)) {
        const candidate = text.replace(/^address[:\s]*/i, '').trim();
        if (!bestAddress || candidate.length < bestAddress.length) bestAddress = candidate;
      }
      if (!data.page_category && (lower.includes('category') || /\bservice\b|\bcompany\b/i.test(lower)) && text.length < 80) {
        data.page_category = text.replace(/^category[:\s]*/i, '').trim();
      }
      if (!data.page_founded_year) {
        const yr = text.match(/founded[^\d]*(\d{4})|(?:^|\s)(\d{4})\b(?=[^\d]*$)/i);
        if (lower.includes('founded') && yr) data.page_founded_year = yr[1] || yr[2];
      }
    }

    // page_location_city / state / country — split the postal address.
    if (bestAddress) {
      data.page_address = bestAddress; // full address (convenience)
      const parts = bestAddress.split(',').map((p) => p.trim()).filter(Boolean);
      const states = ['Maharashtra','Gujarat','Karnataka','Delhi','Tamil Nadu','Telangana','Uttar Pradesh','Madhya Pradesh','Rajasthan','West Bengal','Kerala','Punjab','Haryana','Bihar','Andhra Pradesh','Odisha','Assam','Jharkhand','Chhattisgarh','Uttarakhand','Goa','Himachal Pradesh'];
      const countries = ['India','United States','USA','United Kingdom','UK','UAE','Canada','Australia','Singapore'];
      let idxCountry = -1, idxState = -1;
      parts.forEach((p, i) => {
        if (idxCountry < 0 && countries.some((c) => p.toLowerCase() === c.toLowerCase())) { idxCountry = i; data.page_location_country = p; }
        const st = states.find((s) => p.toLowerCase().includes(s.toLowerCase()));
        if (idxState < 0 && st) { idxState = i; data.page_location_state = st; }
      });
      const anchor = idxCountry >= 0 ? idxCountry : idxState;
      if (anchor > 0) {
        for (let i = anchor - 1; i >= 0; i--) {
          const p = parts[i];
          if (!/^\d/.test(p) && !/plot|no\b|s-\d|opp|road|street|nagar|gurudawara/i.test(p)) { data.page_location_city = p; break; }
        }
      }
    }

    Object.keys(data).forEach((key) => {
      if (!data[key]) delete data[key];
    });

    return data;
  });
}

function extractFacebookProfileFromHTML(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const data = {};
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

  // Field names follow the UNICIRCUIT_MEDIA_DATA_FIELDS spec (FACEBOOK sheet).
  const meta = (sel) => { const m = doc.querySelector(sel); return m ? clean(m.getAttribute('content') || '') : ''; };
  const cleanName = (n) => clean(String(n || '').replace(/^\(\d+\)\s*/, '').split('|')[0]);

  const ogTitle = meta('meta[property="og:title"]');
  const ogDesc = meta('meta[property="og:description"]');
  const ogUrl = meta('meta[property="og:url"]');
  const ogImage = meta('meta[property="og:image"]');
  if (ogTitle) { data.page_og_title = ogTitle; data.page_name = cleanName(ogTitle); }
  if (ogDesc) { data.page_og_description = ogDesc; data.page_description = ogDesc; }
  if (ogUrl) data.page_url = ogUrl;
  if (ogImage) data.page_og_image_url = ogImage;

  if (ogUrl) {
    try {
      const seg = new URL(ogUrl).pathname.split('/').filter(Boolean);
      if (seg[0] && seg[0] !== 'profile.php' && !/^\d+$/.test(seg[0])) data.page_username = seg[0];
    } catch (_) {}
  }

  const bodyText = clean(getCleanText(doc.body));
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3,4}[-.\s]?\d{4,}/;

  const emailMatch = bodyText.match(emailRegex);
  if (emailMatch) data.page_email = emailMatch[0];
  const phoneMatch = bodyText.match(phoneRegex);
  if (phoneMatch) data.page_phone = phoneMatch[0];

  const followerMatch = bodyText.match(/([\d,.]+[KMB]?)\s+followers?/i);
  if (followerMatch) data.page_followers_count = followerMatch[1];
  const likeMatch = bodyText.match(/([\d,.]+[KMB]?)\s+likes?/i);
  if (likeMatch) data.page_likes_count = likeMatch[1];

  return data;
}

async function capturePageForAnalysis(page, url, hostname) {
  const targetUrl = isFacebookHost(hostname) ? getFacebookAboutUrl(url) : url;
  if (isFacebookHost(hostname)) {
    console.log(`[SCRAPER] Facebook page detected — loading About tab: ${targetUrl}`);
  }

  await page.goto(targetUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
  await waitForDynamicContent(page, hostname);

  let profileData = null;
  if (isFacebookHost(hostname)) {
    profileData = await extractFacebookProfileFields(page);
    const fieldCount = Object.keys(profileData).length;
    console.log(`[SCRAPER] Facebook profile extraction found ${fieldCount} field(s): ${Object.keys(profileData).join(', ') || '(none)'}`);
  }

  // Capture in this order: page HTML + element shots on the current (About) tab,
  // THEN navigate to the Reels tab (which changes the page), so nothing above is lost.
  const html = await page.content();
  const elementShots = await captureElementShots(page);
  let reels = [];
  if (isFacebookHost(hostname)) {
    reels = await extractFacebookReels(page, url, hostname);
  }

  return { html, profileData, elementShots, reels };
}

// Build a Facebook tab URL (e.g. /<username>/reels/) forcing English locale.
function getFacebookTabUrl(url, tab) {
  try {
    const parsed = new URL(url);
    const seg = parsed.pathname.split('/').filter(Boolean);
    const base = seg[0] ? `/${seg[0]}` : '';
    const u = new URL(`${parsed.origin}${base}/${tab}`);
    u.searchParams.set('locale', 'en_US');
    return u.toString();
  } catch (_) {
    return url;
  }
}

// Scrape the Reels tab: returns a list of reels, each with its open link (reel
// page), a download link (poster/thumbnail media), thumbnail URL and view count.
async function extractFacebookReels(page, url, hostname) {
  const reelsUrl = getFacebookTabUrl(url, 'reels');
  try {
    console.log(`[SCRAPER] Loading Reels tab: ${reelsUrl}`);
    await page.goto(reelsUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await waitForDynamicContent(page, hostname);
  } catch (err) {
    console.warn(`[SCRAPER] Could not load Reels tab: ${err.message}`);
    return [];
  }

  try {
    const reels = await page.evaluate(() => {
      const toAsciiDigits = (str) => (str || '').replace(/[०-९٠-٩]/g, (d) => {
        const code = d.charCodeAt(0);
        return String(code >= 0x0966 ? code - 0x0966 : code - 0x0660);
      });
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      const seen = new Set();
      const anchors = Array.from(document.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"]'));
      for (const a of anchors) {
        const href = (a.href || '').split('?')[0];
        const m = href.match(/\/reels?\/(\d+)/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);

        const img = a.querySelector('img[src]');
        const thumb = img ? img.src : '';
        // View count = first number in the card overlay (Devanagari normalised).
        const text = toAsciiDigits(clean(a.innerText));
        const viewMatch = text.match(/([\d.,]+\s*[KMB]?)/);
        const views = viewMatch ? viewMatch[1].replace(/\s+/g, '') : '';

        out.push({
          reel_id: id,
          open_link: href,           // reel page — click to watch
          download_link: thumb,      // poster/thumbnail media (direct video needs playback)
          reel_thumbnail_url: thumb,
          reel_views: views,
        });
      }
      return out.slice(0, 80);
    });
    console.log(`[SCRAPER] Extracted ${reels.length} reel(s).`);
    return reels;
  } catch (err) {
    console.warn(`[SCRAPER] Reels extraction failed: ${err.message}`);
    return [];
  }
}

// Click a dropdown/menu trigger and capture the menu it reveals (image + the
// sub-navigation links inside it), then close it. This shows the *effect* of
// clicking. Guards against clicks that navigate away. Never throws.
async function revealElementMenu(page, handle) {
  const urlBefore = page.url();
  try {
    await handle.click({ timeout: 2500 });
  } catch (_) {
    return null;
  }
  await sleep(700);

  // If the click navigated instead of opening a menu, go back and bail.
  if (page.url() !== urlBefore) {
    try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }); await sleep(600); } catch (_) {}
    return null;
  }

  let menuHandle = null;
  try {
    const menus = await page.$$('[role="menu"], [role="listbox"], [role="dialog"] [role="menu"]');
    for (const m of menus) {
      if (await m.isVisible()) {
        const b = await m.boundingBox();
        if (b && b.height > 20) { menuHandle = m; break; }
      }
    }
  } catch (_) {}

  let revealed = null;
  if (menuHandle) {
    try {
      const buffer = await menuHandle.screenshot({ type: 'jpeg', quality: 65, timeout: 4000 });
      const items = await menuHandle.evaluate((el) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const out = [];
        el.querySelectorAll('a[href], [role="menuitem"], [role="tab"]').forEach((it) => {
          const label = norm(it.getAttribute('aria-label') || it.textContent);
          const anchor = it.tagName === 'A' ? it : it.querySelector('a[href]');
          const href = anchor ? anchor.href : '';
          if (label) out.push({ label, href });
        });
        return out.slice(0, 20);
      });
      revealed = { image: `data:image/jpeg;base64,${buffer.toString('base64')}`, items };
    } catch (_) {}
  }

  try { await page.keyboard.press('Escape'); await sleep(250); } catch (_) {}
  return revealed;
}

// Screenshot individual interactive elements (buttons, dropdowns, inputs, tabs,
// nav links) rather than the whole page. Each shot records the click DESTINATION
// (href) so the UI can link to the effect of clicking it — and for dropdown/menu
// triggers it opens the menu and captures the revealed sub-navigation.
// Never throws — returns whatever it managed to capture.
async function captureElementShots(page, max = 32, maxReveals = 6) {
  const selector = [
    'button',
    '[role="button"]',
    'select',
    '[role="combobox"]',
    '[aria-haspopup]',
    '[role="tab"]',
    // Nested navigation inside nav bars / tablists (All, Information, Photo, …)
    '[role="tablist"] a[href]',
    '[role="navigation"] a[href]',
    'input:not([type="hidden"])',
    'textarea',
    'a[role="link"]',
  ].join(',');

  const shots = [];
  let handles = [];
  try {
    handles = await page.$$(selector);
  } catch (_) {
    return shots;
  }

  const seen = new Set();
  let reveals = 0;
  for (const handle of handles) {
    if (shots.length >= max) break;
    try {
      if (!(await handle.isVisible())) continue;
      const box = await handle.boundingBox();
      if (!box || box.width < 10 || box.height < 8 || box.width > 1400 || box.height > 900) continue;

      // De-duplicate elements that occupy the same on-screen rectangle.
      const key = `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const info = await handle.evaluate((el) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 70);
        const tag = el.tagName.toLowerCase();
        const hasPopup = !!el.getAttribute('aria-haspopup');
        let type = tag;
        if (hasPopup || tag === 'select' || el.getAttribute('role') === 'combobox') type = 'dropdown';
        else if (el.getAttribute('role') === 'tab') type = 'tab';
        else if (tag === 'input') type = `input:${el.getAttribute('type') || 'text'}`;
        else if (tag === 'button' || el.getAttribute('role') === 'button') type = 'button';
        else if (tag === 'a') type = 'link';
        const label = norm(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '');
        // Click destination = own href or the nearest ancestor link.
        const anchor = tag === 'a' ? el : el.closest('a[href]');
        const href = anchor && anchor.href && !anchor.href.startsWith('javascript:') ? anchor.href : '';
        return { type, label, href, hasPopup };
      });

      const buffer = await handle.screenshot({ type: 'jpeg', quality: 65, timeout: 4000 });
      const shot = { type: info.type, label: info.label, href: info.href, image: `data:image/jpeg;base64,${buffer.toString('base64')}` };

      // For menu/dropdown triggers without a plain destination, open it and
      // capture the revealed sub-navigation (the effect of clicking).
      if ((info.hasPopup || info.type === 'dropdown') && !info.href && reveals < maxReveals) {
        reveals++;
        const revealed = await revealElementMenu(page, handle);
        if (revealed) shot.revealed = revealed;
      }

      shots.push(shot);
    } catch (_) {
      // Skip elements that detach, move, or fail to capture.
    }
  }
  console.log(`[SCRAPER] Captured ${shots.length} element screenshot(s), ${reveals} menu reveal attempt(s).`);
  return shots;
}

// Helper to safely get the className of any element, handling SVGs and standard elements
function getElementClassName(el) {
  if (!el) return '';
  const cls = el.className;
  if (typeof cls === 'string') return cls;
  if (typeof cls === 'object' && cls !== null && 'baseVal' in cls) {
    return cls.baseVal || '';
  }
  return '';
}

// Translation helper: Mocks translation for demonstration or cleans up characters
function translateToEnglish(text) {
  if (!text) return '';
  return text
    .replace(/[^\x00-\x7F]/g, "") // remove non-ASCII characters
    .trim();
}

// Returns true if the string contains non-ASCII letters (e.g. Devanagari, Chinese)
// worth translating. Pure-ASCII values (already English, numbers, URLs) are skipped.
function needsTranslation(text) {
  return typeof text === 'string' && [...text].some(ch => ch.charCodeAt(0) > 127);
}

// Real translation via Google Translate's public (gtx) endpoint. Auto-detects the
// source language and translates to English. Never throws — returns the original
// text on any failure so extraction always succeeds.
async function googleTranslateToEnglish(text) {
  const input = String(text || '').trim();
  if (!input || !needsTranslation(input)) return input;
  try {
    const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
      params: { client: 'gtx', sl: 'auto', tl: 'en', dt: 't', q: input },
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    // Response shape: [[["translated","original",...], ...], ...]
    const segments = Array.isArray(res.data) && Array.isArray(res.data[0]) ? res.data[0] : [];
    const translated = segments.map(seg => (Array.isArray(seg) ? seg[0] : '')).join('').trim();
    return translated || input;
  } catch (err) {
    console.warn(`[SCRAPER] Google Translate failed (keeping original): ${err.message}`);
    return input;
  }
}

// Translate every non-ASCII string value of a record to English, in parallel.
// Field keys (our own canonical names) are left untouched.
async function translateRecordToEnglish(record) {
  if (!record || typeof record !== 'object') return record;
  const out = {};
  const entries = Object.entries(record);
  await Promise.all(entries.map(async ([key, value]) => {
    out[key] = typeof value === 'string' ? await googleTranslateToEnglish(value) : value;
  }));
  return out;
}

// Date Formatter: Normalizes to YYYY-MM-DD
function formatDate(val) {
  if (!val) return '';
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  } catch (_) {}
  return val;
}

// Number Formatter: Extracts digits and decimals
function formatNumber(val) {
  if (!val && val !== 0) return '';
  const clean = String(val).replace(/[^\d.]/g, '');
  const num = parseFloat(clean);
  return isNaN(num) ? val : num;
}

// Text Formatter: Strips double spaces, normalizes case/casing, trims
function formatText(val) {
  if (!val) return '';
  return String(val)
    .replace(/\s+/g, ' ')
    .trim();
}

// Clean visible, human-readable text from elements, stripping scripts, style tags, and templates
function getCleanText(el) {
  if (!el) return '';
  const tag = el.tagName ? el.tagName.toUpperCase() : '';
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'CANVAS') {
    return '';
  }
  if (el.nodeType === 3) {
    return el.nodeValue;
  }
  let text = '';
  for (const child of el.childNodes) {
    text += ' ' + getCleanText(child);
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Deep search helper for 50-60 level deep nested elements or custom data-attributes
function findValueDeep(item, fieldName) {
  const fLower = fieldName.toLowerCase().trim();
  if (!fLower) return '';

  const allElements = Array.from(item.querySelectorAll('*'));

  // 1. Search data attributes (e.g. data-lead-name, data-company) on all descendants
  for (const el of allElements) {
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i];
      const attrName = attr.name.toLowerCase();
      const attrVal = attr.value.trim();
      
      if (attrName.startsWith('data-') && attrName.includes(fLower) && attrVal) {
        return attrVal;
      }
    }
  }

  // 2. Search common descriptive attributes matching the field name semantics
  for (const el of allElements) {
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i];
      const attrName = attr.name.toLowerCase();
      const attrVal = attr.value.trim();

      // e.g. for "company" or "name", we might find it in img alt text, title, or meta content tags
      if ((attrName === 'alt' || attrName === 'title' || attrName === 'placeholder' || attrName === 'content') && attrVal) {
        const classAndId = (getElementClassName(el) + ' ' + (el.id || '')).toLowerCase();
        if (classAndId.includes(fLower)) {
          return attrVal;
        }
      }
    }
  }

  // 3. Search form input values (e.g. input name="email")
  for (const el of allElements) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const nameAttr = (el.getAttribute('name') || '').toLowerCase();
      const idAttr = (el.getAttribute('id') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      if ((nameAttr.includes(fLower) || idAttr.includes(fLower) || placeholder.includes(fLower)) && el.value) {
        return el.value.trim();
      }
    }
  }

  // 4. Label-Value Text Sibling search (e.g. "Company: Google" or "<span>Company</span><span>Google</span>")
  for (const el of allElements) {
    const text = (el.textContent || '').trim();
    if (text && text.toLowerCase().includes(fLower) && text.includes(':')) {
      const parts = text.split(':');
      if (parts.length > 1 && parts[1].trim()) {
        return parts[1].trim();
      }
    }
  }

  return '';
}

// Main Extraction Core with DOM Selector Boundaries
function extractDataFromHTML(html, fields, options = {}) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  
  const results = [];
  const report = {
    collected: [],
    notCollected: []
  };

  // Expand "Read More" data in HTML if requested
  if (options.expandReadMore) {
    const hiddenEls = doc.querySelectorAll('.hidden, [style*="display: none"], .more-text, [id*="read-more"], .collapsed');
    hiddenEls.forEach(el => {
      el.style.display = 'block';
      el.style.visibility = 'visible';
      el.removeAttribute('hidden');
    });
  }

  // 1. Determine Lead Containers
  let items = [];
  if (options.itemSelector) {
    items = Array.from(doc.querySelectorAll(options.itemSelector));
  } else {
    // Falls back to generic structured rows / card lists
    const fallbacks = ['.card', '.lead-row', '.contact-card', 'table tr', 'ul li', 'ol li', 'div.row'];
    for (const sel of fallbacks) {
      const list = Array.from(doc.querySelectorAll(sel));
      if (list.length > 0) {
        items = list;
        break;
      }
    }
  }

  if (items.length === 0) {
    items = [doc.body];
  }

  // 2. Bound scraping using Start & End CSS selectors
  let startIndex = 0;
  let endIndex = items.length;

  if (options.startSelector) {
    const startEl = doc.querySelector(options.startSelector);
    if (startEl) {
      const idx = items.findIndex(item => item === startEl || startEl.contains(item) || (item.compareDocumentPosition(startEl) & 2));
      if (idx !== -1) {
        startIndex = idx;
      }
    }
  }

  if (options.endSelector) {
    const endEl = doc.querySelector(options.endSelector);
    if (endEl) {
      const idx = items.findIndex(item => item === endEl || endEl.contains(item) || (item.compareDocumentPosition(endEl) & 2));
      if (idx !== -1) {
        endIndex = idx;
      }
    }
  }

  const boundedItems = items.slice(startIndex, endIndex);

  // Email and Phone regexes
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

  const collectedFields = new Set();

  // Parse custom field schema if specified using name | selector | attribute
  const fieldConfigs = fields.map(field => {
    let name = field;
    let selector = '';
    let attr = '';
    
    if (field.includes('|')) {
      const parts = field.split('|').map(p => p.trim());
      name = parts[0];
      selector = parts[1];
      if (parts[2]) {
        attr = parts[2];
      }
    }
    return { original: field, name, selector, attr };
  });

  // Single profile pages (Facebook, etc.) — use pre-extracted structured data
  if (options.profileData && typeof options.profileData === 'object') {
    const record = {};
    const profile = options.profileData;

    fieldConfigs.forEach((config) => {
      let val = profile[config.name] || profile[config.name.toLowerCase()] || '';

      if (!val && config.selector) {
        try {
          const el = doc.querySelector(config.selector);
          if (el) {
            if (config.attr) {
              const aLower = config.attr.toLowerCase();
              if (aLower === 'text') val = el.textContent.trim();
              else if (aLower === 'html' || aLower === 'innerhtml') val = el.innerHTML.trim();
              else val = (el.getAttribute(config.attr) || '').trim();
            } else {
              val = el.textContent.trim();
            }
          }
        } catch (_) {}
      }

      if (!val) {
        val = findValueDeep(doc.body, config.name);
      }

      if (val) {
        collectedFields.add(config.original);
        if (options.translate) val = translateToEnglish(val);
        if (options.formatters?.date) val = formatDate(val);
        if (options.formatters?.number) val = formatNumber(val);
        if (options.formatters?.text) val = formatText(val);
      }

      record[config.name] = val || 'N/A';
    });

    Object.keys(profile).forEach((key) => {
      if (!record[key] || record[key] === 'N/A') {
        record[key] = profile[key];
        collectedFields.add(key);
      }
    });

    if (Object.values(record).some((v) => v !== 'N/A' && v !== '')) {
      results.push(record);
    }

    fields.forEach((field) => {
      const fieldName = field.includes('|') ? field.split('|')[0].trim() : field;
      if (collectedFields.has(field) || collectedFields.has(fieldName) || (record[fieldName] && record[fieldName] !== 'N/A')) {
        report.collected.push(field);
      } else {
        report.notCollected.push(field);
      }
    });

    return { results, report };
  }

  boundedItems.forEach(item => {
    const record = {};
    const textContent = getCleanText(item);
    
    // Extract metadata values if we are doing page-level profile scraping
    const isDocumentBody = item === doc.body;
    let titleText = '';
    let descText = '';
    if (isDocumentBody) {
      const metaTitle = doc.querySelector('meta[property="og:title"], meta[name="twitter:title"], meta[name="title"]');
      const metaDesc = doc.querySelector('meta[property="og:description"], meta[name="twitter:description"], meta[name="description"]');
      if (metaTitle) {
        titleText = (metaTitle.getAttribute('content') || '').split('|')[0].split('-')[0].trim();
      }
      if (metaDesc) {
        descText = metaDesc.getAttribute('content') || '';
      }
    }

    const searchCorpus = isDocumentBody ? `${textContent} ${titleText} ${descText}` : textContent;

    fieldConfigs.forEach(config => {
      let val = '';
      const fLower = config.name.toLowerCase();

      // If custom selector is specified
      if (config.selector) {
        try {
          const el = item.querySelector(config.selector);
          if (el) {
            if (config.attr) {
              const aLower = config.attr.toLowerCase();
              if (aLower === 'text') {
                val = el.textContent.trim();
              } else if (aLower === 'html' || aLower === 'innerhtml') {
                val = el.innerHTML.trim();
              } else {
                val = (el.getAttribute(config.attr) || '').trim();
              }
            } else {
              val = el.textContent.trim();
            }
          }
        } catch (_) {}
      } else {
        // Fall back to heuristics if no custom selector

        // Heuristic A: Query inside item matching field name as selector
        try {
          const queryOptions = [
            `.${config.name}`,
            `#${config.name}`,
            `[class*="${config.name}"]`,
            `[id*="${config.name}"]`,
            `[name*="${config.name}"]`
          ];
          for (const qs of queryOptions) {
            const el = item.querySelector(qs);
            if (el) {
              val = el.textContent.trim();
              break;
            }
          }
        } catch (_) {}

        // Heuristic B: Standard tag match queries
        if (!val) {
          if (fLower.includes('email')) {
            const mailto = item.querySelector('a[href^="mailto:"]');
            if (mailto) {
              val = mailto.getAttribute('href').replace('mailto:', '').trim();
            } else {
              const matches = searchCorpus.match(emailRegex);
              if (matches && matches.length) val = matches[0];
            }
          } else if (fLower.includes('phone') || fLower.includes('tel')) {
            const tel = item.querySelector('a[href^="tel:"]');
            if (tel) {
              val = tel.getAttribute('href').replace('tel:', '').trim();
            } else {
              const matches = searchCorpus.match(phoneRegex);
              if (matches && matches.length) {
                // Filter out non-phone strings (keep numbers between 7 and 15 digits)
                val = matches.find(m => {
                  const digits = m.replace(/\D/g, '').length;
                  return digits >= 7 && digits <= 15;
                }) || '';
              }
            }
          } else if (fLower.includes('company') || fLower.includes('org') || fLower.includes('name')) {
            if (isDocumentBody && titleText) {
              val = titleText;
            }
            if (!val) {
              const h = item.querySelector('h1, h2, h3, .company, .org, .name, strong');
              if (h) val = h.textContent.trim();
            }
          }
        }

        // Heuristic C: Table column index mapping
        if (!val && item.tagName === 'TR') {
          const colIdx = fieldConfigs.findIndex(c => c.name === config.name);
          const cells = Array.from(item.querySelectorAll('td, th'));
          if (cells[colIdx]) {
            val = cells[colIdx].textContent.trim();
          }
        }

        // Heuristic D: Schema.org JSON-LD parsing inside item container
        if (!val) {
          const script = item.querySelector('script[type="application/ld+json"]');
          if (script) {
            try {
              const json = JSON.parse(script.textContent);
              if (fLower.includes('name') && json.name) val = json.name;
              else if (fLower.includes('email') && json.email) val = json.email;
              else if ((fLower.includes('phone') || fLower.includes('tel')) && json.telephone) val = json.telephone;
              else if (json[config.name]) val = json[config.name];
            } catch (_) {}
          }
        }

        // Heuristic E: Deep recursive search fallback
        if (!val) {
          val = findValueDeep(item, config.name);
        }
      }

      // Apply Formatters & Cleanups
      if (val) {
        collectedFields.add(config.original);
        if (options.translate) {
          val = translateToEnglish(val);
        }
        if (options.formatters?.date) {
          val = formatDate(val);
        }
        if (options.formatters?.number && (fLower.includes('phone') || fLower.includes('number') || fLower.includes('val') || fLower.includes('score') || fLower.includes('id'))) {
          val = formatNumber(val);
        }
        if (options.formatters?.text) {
          val = formatText(val);
        }
      }

      record[config.name] = val || 'N/A';
    });

    if (Object.values(record).some(v => v !== 'N/A' && v !== '')) {
      results.push(record);
    }
  });

  fields.forEach(field => {
    if (collectedFields.has(field)) {
      report.collected.push(field);
    } else {
      report.notCollected.push(field);
    }
  });

  return { results, report };
}

// Start active scraping session
// Start active scraping session
async function startScrape(sessionId, params) {
  const {
    url,
    fields = ['name', 'company', 'email', 'phone'],
    startPoint = 1,
    endPoint = 5,
    bufferTime = 1000,
    expandReadMore = false,
    translate = false,
    formatters = { text: true, date: true, number: true },
    pagination = { enabled: false, paramName: 'page', selector: '' },
    itemSelector = '',
    startSelector = '',
    endSelector = '',
    cookies = null,
    showBrowser = false
  } = params;

  const session = {
    sessionId,
    status: 'running',
    scrapedData: [],
    report: { collected: [], notCollected: [] },
    progress: { currentPage: 0, totalCollected: 0 },
    stop: false
  };

  activeSessions.set(sessionId, session);

  // Background scraper execution loop
  (async () => {
    let browserInstance = null;
    try {
      const crawled = new Set();
      const queue = [url];
      let pagesTraversed = 0;
      const maxPages = parseInt(endPoint) || 5;

      const parsedCookies = parseCookies(cookies);
      // Always use a visible browser regardless of cookies or showBrowser flag
      let browserPage = null;

      console.log(`[SCRAPER] Session ${sessionId}: Starting visible Chrome browser for URL: ${url}`);
      try {
        // Persistent profile: the context IS the session (no separate browser).
        const context = await openStealthSession();
        browserInstance = context;

        // Inject parsed cookies if any
        if (parsedCookies.length > 0) {
          const formattedCookies = parsedCookies.map(cookie => {
            if (!cookie.domain && !cookie.url) {
              try {
                const urlObj = new URL(url);
                cookie.domain = urlObj.hostname;
              } catch (_) {}
            }
            return {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path || '/',
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              expires: cookie.expires
            };
          });
          await context.addCookies(formattedCookies);
          console.log(`[SCRAPER] Session ${sessionId}: Successfully injected ${formattedCookies.length} cookies.`);
        }
        
        browserPage = await context.newPage();
      } catch (pwErr) {
        console.error(`[SCRAPER ERROR] Session ${sessionId}: Failed to boot Playwright browser context:`, pwErr.message);
        if (browserInstance) {
          await browserInstance.close();
          browserInstance = null;
        }
      }

      // Handle standard parameter-based pagination queue pre-population
      if (pagination.enabled && !pagination.selector) {
        const start = parseInt(startPoint) || 1;
        for (let p = start + 1; p <= maxPages; p++) {
          const separator = url.includes('?') ? '&' : '?';
          queue.push(`${url}${separator}${pagination.paramName}=${p}`);
        }
      }

      while (queue.length > 0 && pagesTraversed < maxPages && !session.stop) {
        const targetUrl = queue.shift();
        if (!targetUrl || crawled.has(targetUrl)) continue;

        crawled.add(targetUrl);
        pagesTraversed++;
        session.progress.currentPage = pagesTraversed;

        console.log(`[SCRAPER] Scraping URL (${pagesTraversed}/${maxPages}): ${targetUrl}`);
        
        let html = '';
        let profileData = null;
        try {
          // Verify URL protocol
          const parsed = new URL(targetUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('Invalid URL protocol. Target must be http or https.');
          }

          if (browserInstance && browserPage) {
            console.log(`[SCRAPER] Session ${sessionId}: Fetching URL via visible browser: ${targetUrl}`);
            if (isFacebookHost(parsed.hostname)) {
              const captured = await capturePageForAnalysis(browserPage, targetUrl, parsed.hostname);
              html = captured.html;
              profileData = captured.profileData;
            } else {
              await browserPage.goto(targetUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
              await waitForDynamicContent(browserPage, parsed.hostname);
              html = await browserPage.content();
            }
          } else {
            // Fallback to Axios only if browser failed to start
            console.log(`[SCRAPER] Session ${sessionId}: Browser unavailable, falling back to Axios: ${targetUrl}`);
            const response = await axios.get(targetUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
              },
              timeout: 5000,
              maxContentLength: 5 * 1024 * 1024, // 5MB limit
              validateStatus: () => true
            });

            html = response.data;
            const contentType = response.headers['content-type'] || '';

            if (response.status !== 200) {
              const looksLikeHTML = typeof html === 'string' && (html.toLowerCase().includes('<html') || html.toLowerCase().includes('<div') || html.toLowerCase().includes('<!doctype'));
              if (!looksLikeHTML || (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/xml'))) {
                throw new Error(`Server returned error status: ${response.status} (${response.response?.statusText || 'Bad Request'})`);
              }
            }
          }
          
          if (typeof html !== 'string') {
            throw new Error('Response is not HTML text');
          }

          // Verify if we hit a verification page, captcha, Turnstile, or Cloudflare challenge
          const htmlLower = html.toLowerCase();
          const verificationKeywords = [
            'i am not a robot', 'cloudflare turnstile', 'hcaptcha', 'g-recaptcha',
            'verification code', 'verify your identity', 'two-step verification',
            'verify you are human', 'prove you are human', 'one-time password',
            'enter the code', 'security check'
          ];
          if (verificationKeywords.some(kw => htmlLower.includes(kw))) {
            throw new Error('A 2-step verification, CAPTCHA, or "I am not a robot" security check blocked the automated scraper.');
          }
        } catch (fetchErr) {
          let msg = fetchErr.message;
          if (fetchErr.code === 'ECONNABORTED' || fetchErr.message.includes('timeout')) {
            msg = 'Request timed out (site may be offline or fake)';
          } else if (fetchErr.code === 'ENOTFOUND') {
            msg = 'Domain resolution failed (DNS invalid or domain is fake)';
          } else if (fetchErr.code === 'ECONNREFUSED') {
            msg = 'Connection refused by target server';
          } else if (fetchErr.response) {
            msg = `Server returned status: ${fetchErr.response.status}`;
          }
          console.error(`[SCRAPER WARNING] Failed to crawl ${targetUrl}: ${msg}`);
          if (!session.errors) session.errors = [];
          session.errors.push(`Failed to crawl ${targetUrl}: ${msg}`);
          continue; // Skip to next page in queue
        }

        if (bufferTime > 0) {
          await sleep(parseInt(bufferTime));
        }

        const { results, report } = extractDataFromHTML(html, fields, {
          translate,
          formatters,
          expandReadMore,
          itemSelector: profileData ? 'body' : itemSelector,
          startSelector,
          endSelector,
          profileData
        });

        if (results && results.length) {
          session.scrapedData.push(...results);
          session.progress.totalCollected = session.scrapedData.length;
        }

        session.report.collected = [...new Set([...session.report.collected, ...report.collected])];
        session.report.notCollected = report.notCollected.filter(f => !session.report.collected.includes(f));

        // Scan page pagination bar if selector is enabled
        if (pagination.enabled && pagination.selector) {
          try {
            let urlsFound = [];

            if (browserInstance && browserPage) {
              const anchors = await browserPage.$$eval(`${pagination.selector} a`, (links) => {
                return links.map(a => a.getAttribute('href')).filter(Boolean);
              });
              urlsFound = anchors.map(href => {
                try {
                  return new URL(href, targetUrl).toString();
                } catch (_) {
                  return '';
                }
              }).filter(Boolean);
            } else {
              const dom = new JSDOM(html);
              const doc = dom.window.document;
              const pagContainer = doc.querySelector(pagination.selector);
              if (pagContainer) {
                const anchors = Array.from(pagContainer.querySelectorAll('a'));
                urlsFound = anchors
                  .map(a => a.getAttribute('href'))
                  .filter(Boolean)
                  .map(href => {
                    try {
                      return new URL(href, targetUrl).toString();
                    } catch (_) {
                      return '';
                    }
                  })
                  .filter(Boolean);
              }
            }
            
            const uniqueUrls = [...new Set(urlsFound)];
            uniqueUrls.forEach(u => {
              if (!crawled.has(u) && !queue.includes(u)) {
                queue.push(u);
              }
            });
            console.log(`[SCRAPER] Extracted ${uniqueUrls.length} pages from pagination bar selector: "${pagination.selector}"`);
          } catch (err) {
            console.error(`[SCRAPER] Failed to extract links from pagination bar selector:`, err.message);
          }
        }

        if (!pagination.enabled) {
          break;
        }
      }

      session.status = session.stop ? 'stopped' : 'completed';
    } catch (err) {
      console.error('[SCRAPER ERROR]', err.message);
      session.status = 'failed';
      session.error = err.message;
    } finally {
      // Persistent profile auto-persists cookies/localStorage to disk on close.
      if (browserInstance) {
        try {
          await browserInstance.close();
          console.log(`[SCRAPER] Session ${sessionId}: Playwright browser session closed.`);
        } catch (_) {}
      }
    }
  })();

  return session;
}

// Stop active scraping session
function stopScrape(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.stop = true;
    session.status = 'stopped';
    return session;
  }
  return null;
}

// Get session status
function getScrapeStatus(sessionId) {
  return activeSessions.get(sessionId) || null;
}

// Local HTML Document parser
function parseLocalHTML(htmlContent, fields, options) {
  return extractDataFromHTML(htmlContent, fields, options);
}

// Automatically analyze a target URL's DOM structure to detect items, selectors, pagination, and fields
async function analyzeURL(url, cookies = null, showBrowser = false) {
  try {
    // 1. URL syntax validation
    let parsed;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Protocol must be http or https');
      }
    } catch (_) {
      return { success: false, url, error: 'Invalid URL format. Please make sure to include http:// or https://' };
    }

    let html = '';
    let usedPlaywright = false;
    let playwrightBrowser = null;
    let extractedCookies = null;
    let profileData = null;
    let elementShots = null;
    let reels = null;
    const parsedCookies = parseCookies(cookies);

    // 2. Always use a visible Playwright browser for analysis regardless of showBrowser flag
    try {
      console.log(`[SCRAPER] Analyzing URL with visible Chrome browser: ${url}`);
      // Persistent profile: context IS the session; closing it closes the browser.
      const context = await openStealthSession();
      playwrightBrowser = context;

      if (parsedCookies.length > 0) {
        const formattedCookies = parsedCookies.map(cookie => {
          if (!cookie.domain && !cookie.url) {
            try {
              const urlObj = new URL(url);
              cookie.domain = urlObj.hostname;
            } catch (_) {}
          }
          return {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expires: cookie.expires
          };
        });
        await context.addCookies(formattedCookies);
        console.log(`[SCRAPER] Injected ${formattedCookies.length} cookies into analyzer browser context.`);
      }

      const page = await context.newPage();
      
      // Navigate with 15-second timeout and wait for DOM loaded
      await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
      // Brief pause for dynamic content to settle
      await sleep(1500);
      
      const currentUrl = page.url();
      const targetHostname = parsed.hostname;
      
      // Detect login wall using visible password fields and login URLs (not broad "auth" matches)
      const hasPasswordInput = await isVisiblePasswordField(page);
      const isLoginWall = hasPasswordInput || isLoginUrl(currentUrl);
      
      if (isLoginWall) {
        console.log(`[SCRAPER] Login wall detected on ${url}. Browser already visible — waiting for manual login...`);
        
        const loggedIn = await waitForManualLogin(page, context, url, targetHostname);
        
        if (!loggedIn) {
          clearLoginWaitStatus();
          await playwrightBrowser.close();
          return {
            success: false,
            url,
            error: 'Website requires login. The manual login window timed out (5 min) or was closed before login completed.'
          };
        }
        
        // Bypassed! Load target page and extract profile/content under logged-in session
        console.log(`[SCRAPER] Reloading target URL under logged-in session: ${url}`);
        updateLoginWaitStatus({
          phase: 'analyzing',
          message: 'Login complete — analyzing page structure...',
          remainingMs: 0
        });
        const captured = await capturePageForAnalysis(page, url, targetHostname);
        html = captured.html;
        profileData = captured.profileData;
        elementShots = captured.elementShots;
        reels = captured.reels;
        extractedCookies = await context.cookies();
        usedPlaywright = true;
        clearLoginWaitStatus();
        await playwrightBrowser.close();
      } else {
        // Detect Placeholder/Blank Content in dynamic DOM (only if it wasn't a login wall)
        const visibleText = await page.textContent('body');
        const wordCount = visibleText ? visibleText.split(/\s+/).filter(Boolean).length : 0;
        
        if (wordCount < 20 || (visibleText && visibleText.toLowerCase().includes('example domain'))) {
          await playwrightBrowser.close();
          return {
            success: false,
            url,
            error: 'Website appears to be a placeholder or has insufficient content for scraping.'
          };
        }
        
        const captured = await capturePageForAnalysis(page, url, targetHostname);
        html = captured.html;
        profileData = captured.profileData;
        elementShots = captured.elementShots;
        reels = captured.reels;
        extractedCookies = await context.cookies();
        usedPlaywright = true;
        await playwrightBrowser.close();
        console.log(`[SCRAPER] Playwright analysis successful. Loaded HTML content size: ${html.length} bytes.`);
      }
    } catch (pwErr) {
      clearLoginWaitStatus();
      console.warn(`[SCRAPER WARNING] Playwright analyzer failed or timed out: ${pwErr.message}. Falling back to Axios...`);
      if (playwrightBrowser) {
        try {
          await playwrightBrowser.close();
        } catch (_) {}
      }
    }

    // Fallback to Axios if Playwright failed
    if (!usedPlaywright) {
      console.log(`[SCRAPER] Fetching target URL using static Axios HTTP client: ${url}`);
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: 5000,
        maxContentLength: 5 * 1024 * 1024, // 5MB limit
        validateStatus: () => true // Allow checking body of non-200 responses
      });

      html = response.data;
      const contentType = response.headers['content-type'] || '';

      if (response.status !== 200) {
        const looksLikeHTML = typeof html === 'string' && (html.toLowerCase().includes('<html') || html.toLowerCase().includes('<div') || html.toLowerCase().includes('<!doctype'));
        if (!looksLikeHTML || (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/xml'))) {
          throw new Error(`Website returned error status: ${response.status} (${response.statusText || 'Bad Request'})`);
        }
      }

      if (typeof html !== 'string') {
        throw new Error('Response body is not HTML text');
      }

      // Check for login wall or placeholder in static JSDOM
      const domCheck = new JSDOM(html);
      const docCheck = domCheck.window.document;

      const hasPasswordInput = docCheck.querySelector('input[type="password"]');
      const finalUrl = response.request?.res?.responseUrl || url;
      const isLoginWall = hasPasswordInput || finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('auth');

      if (isLoginWall) {
        return {
          success: false,
          url,
          error: 'Website requires login credentials to view content. Scraping is blocked by a credentials wall.'
        };
      }

      const visibleText = getCleanText(docCheck.body);
      const wordCount = visibleText ? visibleText.split(/\s+/).filter(Boolean).length : 0;
      if (wordCount < 20 || visibleText.toLowerCase().includes('example domain')) {
        return {
          success: false,
          url,
          error: 'Website appears to be a placeholder or has insufficient content for scraping.'
        };
      }
    }

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // A. Detect Pagination parameter & pagination selectors
    let detectedPagination = {
      enabled: false,
      paramName: 'page',
      selector: ''
    };

    // Scan links on the page for pagination indicators
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const paginationKeywords = ['page', 'p', 'offset', 'start', 'limit'];
    
    for (const link of links) {
      const href = link.getAttribute('href');
      try {
        const parsedUrl = new URL(href, url);
        for (const kw of paginationKeywords) {
          if (parsedUrl.searchParams.has(kw)) {
            detectedPagination.enabled = true;
            detectedPagination.paramName = kw;
            break;
          }
        }
      } catch (_) {}
      
      if (detectedPagination.enabled) break;
    }

    // Check pagination bar selectors
    const pagBarKeywords = ['.pagination', '.pager', '.pages', '.pagination-next', '.next-page', 'nav.pages', '[class*="pagination"]', '[class*="pager"]'];
    for (const kw of pagBarKeywords) {
      try {
        if (doc.querySelector(kw)) {
          detectedPagination.enabled = true;
          detectedPagination.selector = kw;
          break;
        }
      } catch (_) {}
    }

    // B. Detect repeating Item Containers (or single profile pages like Facebook)
    let detectedItemSelector = '';
    const suggestedFields = [];
    const fieldMappingHelp = {};

    if (profileData && Object.keys(profileData).length > 0) {
      detectedItemSelector = 'body';
      Object.keys(profileData).forEach((field) => {
        suggestedFields.push(field);
        fieldMappingHelp[field] = field;
      });
      console.log(`[SCRAPER] Profile page mode — using ${suggestedFields.length} extracted field(s)`);
    } else if (isFacebookHost(parsed.hostname)) {
      profileData = extractFacebookProfileFromHTML(html);
      if (Object.keys(profileData).length > 0) {
        detectedItemSelector = 'body';
        Object.keys(profileData).forEach((field) => {
          suggestedFields.push(field);
          fieldMappingHelp[field] = field;
        });
      }
    }

    if (!detectedItemSelector) {
    const classFrequencies = {};

    // Collect all elements that might act as item containers
    const candidates = Array.from(doc.querySelectorAll('tr, li, div, section, article'));
    
    for (const el of candidates) {
      // Containers should have text and some height/structure (we approximate by looking at children count > 1)
      if (el.children.length > 1 && (el.textContent || '').trim().length > 10) {
        // Build class selectors
        const classes = Array.from(el.classList);
        classes.forEach(cls => {
          if (cls && !['row', 'col', 'flex', 'container', 'grid', 'd-flex'].includes(cls.toLowerCase())) {
            const tagLower = el.tagName.toLowerCase();
            const fullSel = `${tagLower}.${cls}`;
            classFrequencies[fullSel] = (classFrequencies[fullSel] || 0) + 1;
          }
        });
        
        // Also track tables / list tags directly if they appear frequently
        if (el.tagName === 'TR') {
          classFrequencies['tr'] = (classFrequencies['tr'] || 0) + 1;
        } else if (el.tagName === 'LI') {
          classFrequencies['li'] = (classFrequencies['li'] || 0) + 1;
        }
      }
    }

    // Find the selector with the highest frequency between 3 and 100 occurrences (most typical listings page)
    let bestSel = '';
    let maxFreq = 0;
    for (const sel in classFrequencies) {
      const freq = classFrequencies[sel];
      if (freq >= 3 && freq <= 100 && freq > maxFreq) {
        // Give preference to semantic classes containing 'card', 'item', 'row', 'lead', 'contact'
        const sLower = sel.toLowerCase();
        const hasSemanticWord = sLower.includes('card') || sLower.includes('item') || sLower.includes('row') || sLower.includes('lead') || sLower.includes('contact');
        
        if (hasSemanticWord || !bestSel || freq > maxFreq + 5) {
          bestSel = sel;
          maxFreq = freq;
        }
      }
    }

    detectedItemSelector = bestSel || 'div.row';

    // C. Detect Fields within that container
    const sampleItems = doc.querySelectorAll(detectedItemSelector);

    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

    if (sampleItems.length > 0) {
      // Pick first item as sample to analyze fields
      const sample = sampleItems[0];
      const children = Array.from(sample.querySelectorAll('*'));
      
      // 1. Email check
      const mailto = sample.querySelector('a[href^="mailto:"]');
      if (mailto) {
        suggestedFields.push('email');
        fieldMappingHelp['email'] = `email | a[href^="mailto:"] | href`;
      } else {
        const hasEmailText = children.find(c => emailRegex.test(c.textContent || ''));
        if (hasEmailText) {
          suggestedFields.push('email');
          // Find matching class name
          const classMatch = children.find(c => getElementClassName(c).toLowerCase().includes('email'));
          fieldMappingHelp['email'] = (classMatch && classMatch.classList && classMatch.classList.length > 0) ? `email | .${classMatch.classList[0]}` : 'email';
        }
      }

      // 2. Phone check
      const tel = sample.querySelector('a[href^="tel:"]');
      if (tel) {
        suggestedFields.push('phone');
        fieldMappingHelp['phone'] = `phone | a[href^="tel:"] | href`;
      } else {
        const hasPhoneText = children.find(c => phoneRegex.test(c.textContent || ''));
        if (hasPhoneText) {
          suggestedFields.push('phone');
          const classMatch = children.find(c => {
            const classAndId = (getElementClassName(c) + ' ' + (c.id || '')).toLowerCase();
            return classAndId.includes('phone') || classAndId.includes('tel') || classAndId.includes('contact');
          });
          fieldMappingHelp['phone'] = (classMatch && classMatch.classList && classMatch.classList.length > 0) ? `phone | .${classMatch.classList[0]}` : 'phone';
        }
      }

      // 3. Name check (headers, strong tags, classes matching name)
      const nameEl = sample.querySelector('h1, h2, h3, h4, strong, [class*="name" i], [class*="title" i]');
      if (nameEl) {
        suggestedFields.push('name');
        const tag = nameEl.tagName.toLowerCase();
        const classes = Array.from(nameEl.classList);
        if (classes.length > 0) {
          fieldMappingHelp['name'] = `name | ${tag}.${classes[0]}`;
        } else {
          fieldMappingHelp['name'] = `name | ${tag}`;
        }
      } else {
        suggestedFields.push('name');
        fieldMappingHelp['name'] = 'name';
      }

      // 4. Company check (classes/headers)
      const compEl = sample.querySelector('[class*="company" i], [class*="org" i], [class*="business" i], [class*="brand" i]');
      if (compEl) {
        suggestedFields.push('company');
        const tag = compEl.tagName.toLowerCase();
        const classes = Array.from(compEl.classList);
        fieldMappingHelp['company'] = classes.length > 0 ? `company | ${tag}.${classes[0]}` : `company | ${tag}`;
      } else {
        // Scan other elements for standard attributes
        const imgLogo = sample.querySelector('img[alt], img[title]');
        if (imgLogo) {
          suggestedFields.push('company');
          fieldMappingHelp['company'] = `company | img | alt`;
        } else {
          suggestedFields.push('company');
          fieldMappingHelp['company'] = 'company';
        }
      }

      // 5. General address / location check
      const locEl = sample.querySelector('[class*="address" i], [class*="location" i], [class*="city" i], address');
      if (locEl) {
        suggestedFields.push('address');
        const tag = locEl.tagName.toLowerCase();
        const classes = Array.from(locEl.classList);
        fieldMappingHelp['address'] = classes.length > 0 ? `address | ${tag}.${classes[0]}` : `address | ${tag}`;
      }
    } else {
      // Standard list of fields if sample elements aren't loaded
      suggestedFields.push('name', 'company', 'email', 'phone');
      fieldMappingHelp['name'] = 'name';
      fieldMappingHelp['company'] = 'company';
      fieldMappingHelp['email'] = 'email';
      fieldMappingHelp['phone'] = 'phone';
    }
    }

    // ── FIELD DETECTION LOGS ──────────────────────────────────────────────────
    const uniqueFields = suggestedFields.filter((v, i, self) => self.indexOf(v) === i);
    console.log(`[SCRAPER] ── URL Analysis Complete: ${url}`);
    console.log(`[SCRAPER] ── Item Container Selector : "${detectedItemSelector}"`);
    console.log(`[SCRAPER] ── Pagination Detected     : ${detectedPagination.enabled ? 'YES' : 'NO'}${
      detectedPagination.enabled
        ? ` | param="${detectedPagination.paramName}" | selector="${detectedPagination.selector || 'none'}"`
        : ''
    }`);
    console.log(`[SCRAPER] ── Fields Detected (${uniqueFields.length}) ──────────────────`);
    if (uniqueFields.length === 0) {
      console.log(`[SCRAPER]    (no fields detected — page may require login or be empty)`);
    } else {
      uniqueFields.forEach((field, idx) => {
        const mapping = fieldMappingHelp[field] || field;
        const hasSel = mapping.includes('|');
        const parts = mapping.split('|').map(p => p.trim());
        if (hasSel) {
          console.log(`[SCRAPER]    [${idx + 1}] Field: "${field}"`);
          console.log(`[SCRAPER]        → Selector : "${parts[1] || '(none)'}"`);
          if (parts[2]) console.log(`[SCRAPER]        → Attribute: "${parts[2]}"`);
          console.log(`[SCRAPER]        → Mapping  : "${mapping}"`);
        } else {
          console.log(`[SCRAPER]    [${idx + 1}] Field: "${field}" → Mapping: "${mapping}" (heuristic fallback)`);
        }
      });
    }
    console.log(`[SCRAPER] ─────────────────────────────────────────────────────`);
    // ─────────────────────────────────────────────────────────────────────────

    // Translate the extracted profile record to English via Google Translate so
    // non-English pages (e.g. Marathi Facebook pages) yield English field values.
    if (profileData && Object.keys(profileData).length > 0) {
      const before = Object.keys(profileData).length;
      profileData = await translateRecordToEnglish(profileData);
      console.log(`[SCRAPER] Translated ${before} profile field(s) to English via Google Translate.`);
    }

    return {
      success: true,
      url,
      html, // full page HTML so the frontend can run its client-side DOM/pattern analysis
      elementShots: elementShots && elementShots.length ? elementShots : undefined, // per-element snapshots (buttons, dropdowns, inputs…)
      reels: reels && reels.length ? reels : undefined, // list of reels (open + download links)
      itemSelector: detectedItemSelector,
      pagination: detectedPagination,
      suggestedFields: uniqueFields,
      fieldMappingHelp,
      sampleRecord: profileData || undefined,
      isProfilePage: !!(profileData && Object.keys(profileData).length > 0),
      cookies: extractedCookies ? JSON.stringify(extractedCookies) : undefined
    };

  } catch (err) {
    let errMsg = err.message || 'Failed to reach URL.';
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      errMsg = 'Target website timed out (failed to respond within 5s). The URL may be offline or fake.';
    } else if (err.code === 'ENOTFOUND') {
      errMsg = 'Target domain not found (DNS resolution failed). The website is likely fake or typed incorrectly.';
    } else if (err.code === 'ECONNREFUSED') {
      errMsg = 'Connection refused by target server. They may be blocking requests or offline.';
    } else if (err.response) {
      errMsg = `Website returned error status: ${err.response.status} (${err.response.statusText})`;
    }
    return {
      success: false,
      url,
      error: errMsg
    };
  }
}



// --- AI EXTRACTION PIPELINE ---

async function fetchPublicPageHtml(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('Invalid URL format. Please include http:// or https://');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  // Prefer headless Chrome so JS-rendered / lazy-loaded content is captured.
  try {
    console.log(`[SCRAPER] Rendering URL with headless Chrome: ${url}`);
    const rendered = await renderUrlWithChrome(url, {
      navigationTimeoutMs: 60000,
      extraWaitMs: 20000,
      autoScrollSteps: 8,
    });

    const html = rendered.html || '';
    if (!html || (!html.toLowerCase().includes('<html') && !html.toLowerCase().includes('<body'))) {
      throw new Error('Chrome render did not return readable HTML.');
    }

    const dom = new JSDOM(html);
    const hasPasswordInput = !!dom.window.document.querySelector('input[type="password"]');
    const finalUrl = rendered.finalUrl || url;
    const loginWall =
      hasPasswordInput || /login|signin|two-factor|checkpoint|verify/i.test(finalUrl);
    if (loginWall) {
      throw new Error(
        'This page appears to require login or verification. Use Paste HTML after signing in inside your own browser.'
      );
    }

    return { html, finalUrl, chromeRendered: true };
  } catch (chromeErr) {
    console.warn(`[SCRAPER] Chrome render failed (${chromeErr.message}). Falling back to Axios...`);
  }

  const response = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 15000,
    maxContentLength: 5 * 1024 * 1024,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`Public URL fetch failed with status ${response.status}.`);
  }

  const html = typeof response.data === 'string' ? response.data : '';
  if (!html || (!html.toLowerCase().includes('<html') && !html.toLowerCase().includes('<body'))) {
    throw new Error('The URL did not return readable HTML content.');
  }

  const dom = new JSDOM(html);
  const hasPasswordInput = !!dom.window.document.querySelector('input[type="password"]');
  const finalUrl = response.request?.res?.responseUrl || url;
  const loginWall = hasPasswordInput || /login|signin|two-factor|checkpoint|verify/i.test(finalUrl);
  if (loginWall) {
    throw new Error(
      'This page appears to require login or verification. Use Paste HTML after signing in inside your own browser.'
    );
  }

  return { html, finalUrl, chromeRendered: false };
}

function heuristicExtractLeadsFromHTML(html, url = '') {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const defaultFields = ['name', 'company', 'email', 'phone', 'address', 'website'];
  const { results } = extractDataFromHTML(html, defaultFields, {
    expandReadMore: true,
    formatters: { text: true, date: true, number: true }
  });

  const cleanedRows = (results || [])
    .map((row) => {
      const cleaned = {};
      Object.entries(row).forEach(([key, value]) => {
        const val = String(value || '').trim();
        if (val && val !== 'N/A') cleaned[key] = val;
      });
      return cleaned;
    })
    .filter((row) => Object.keys(row).length > 0);

  if (cleanedRows.length > 0) {
    return {
      page_title: (doc.title || '').trim() || 'Extracted Page',
      extracted_fields: cleanedRows,
      navigation_links: []
    };
  }

  const bodyText = getCleanText(doc.body || doc.documentElement);
  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = bodyText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4,}/);
  const ogTitle = doc.querySelector('meta[property="og:title"]');
  const ogDesc = doc.querySelector('meta[property="og:description"]');

  const singleRow = {};
  if (ogTitle) singleRow.name = (ogTitle.getAttribute('content') || '').trim();
  if (!singleRow.name && doc.title) singleRow.name = doc.title.trim();
  if (ogDesc) singleRow.description = (ogDesc.getAttribute('content') || '').trim();
  if (emailMatch) singleRow.email = emailMatch[0];
  if (phoneMatch) singleRow.phone = phoneMatch[0];
  if (url) singleRow.page_url = url;

  return {
    page_title: singleRow.name || (doc.title || '').trim() || 'Extracted Page',
    extracted_fields: Object.keys(singleRow).length ? [singleRow] : [],
    navigation_links: []
  };
}

function extractJsonBlock(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('extractJsonBlock: LLM response was empty or not text');
  }
  let text = rawText.trim();
  const fenceMatch = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('extractJsonBlock: no JSON object found in LLM response');
  }
  const jsonCandidate = text.slice(firstBrace, lastBrace + 1);
  let parsed;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (err) {
    throw new Error('extractJsonBlock: failed to parse JSON from LLM response: ' + err.message);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extractJsonBlock: parsed JSON is not a plain object');
  }
  return parsed;
}

function sanitizeNavigationLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) return [];
  return rawLinks
    .filter(link => link && typeof link === 'object' && typeof link.url === 'string' && link.url.trim() !== '')
    .map(link => ({
      link_text: typeof link.link_text === 'string' ? link.link_text.trim() : '',
      url: link.url.trim(),
    }));
}

function sanitizeExtractedData(rawArray) {
  if (!Array.isArray(rawArray)) return [];
  return rawArray
    .map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const cleaned = {};
      for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined) continue;
        const strVal = String(value).trim();
        if (strVal === '') continue;
        cleaned[key] = strVal;
      }
      return cleaned;
    })
    .filter(row => row && Object.keys(row).length > 0);
}

const scraperFetchDeps = {
  fetchPageHtml: async (targetUrl) => fetchPublicPageHtml(targetUrl),
  heuristicFallback: (pageHtml, targetUrl) =>
    heuristicToRecordTypes(heuristicExtractLeadsFromHTML(pageHtml, targetUrl)),
  heuristicDiscoverFallback: (pageHtml, targetUrl) =>
    heuristicDiscoverFromHeuristic(heuristicExtractLeadsFromHTML(pageHtml, targetUrl)),
};

async function discoverVariableFields({ sourceType = 'manual_html', url = '', html = '' } = {}) {
  return runFieldDiscovery({
    sourceType,
    url,
    html,
    ...scraperFetchDeps,
  });
}

async function extractAllFieldsWithAI({
  sourceType = 'manual_html',
  url = '',
  html = '',
  mode = 'extract',
  selectedFieldsByType = null,
} = {}) {
  if (mode === 'discover') {
    return discoverVariableFields({ sourceType, url, html });
  }

  return runDeepExtraction({
    sourceType,
    url,
    html,
    selectedFieldsByType,
    ...scraperFetchDeps,
  });
}

// Open the persistent Chrome profile, let the user log in to Facebook (or any
// site) manually, then CLOSE the context so the login is flushed to the profile
// on disk. After this, future analyze/scrape runs reuse the logged-in session.
async function loginAndSaveSession(url) {
  const target = url || 'https://www.facebook.com/';
  let hostname = 'facebook.com';
  try { hostname = new URL(target).hostname; } catch (_) {}

  let context = null;
  try {
    context = await openStealthSession();
  } catch (err) {
    // launchPersistentContext throws if the profile is already open elsewhere.
    const busy = /ProcessSingleton|already (in use|running)|SingletonLock|profile/i.test(err.message);
    return {
      success: false,
      error: busy
        ? 'The scraper Chrome profile is already open. Close any existing scraper browser window and try again.'
        : `Could not start the browser: ${err.message}`,
    };
  }

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(target, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(1500);

    // Already logged in? (auth cookies present and not on a login page.)
    if ((await hasSessionAuthCookies(context, hostname)) && !isLoginUrl(page.url())) {
      const cookies = await context.cookies();
      await context.close(); // flush profile to disk
      clearLoginWaitStatus();
      console.log(`[SCRAPER] Session already logged in (${cookies.length} cookies). Profile saved.`);
      return { success: true, alreadyLoggedIn: true, cookieCount: cookies.length };
    }

    console.log('[SCRAPER] Waiting for manual Facebook login in the opened browser...');
    const loggedIn = await waitForManualLogin(page, context, target, hostname);

    // Give Chromium a beat to write cookies, then read + close to persist.
    await sleep(2500);
    const cookies = await context.cookies();
    const authOk = await hasSessionAuthCookies(context, hostname);
    await context.close(); // graceful close flushes the persistent profile to disk
    clearLoginWaitStatus();

    if (loggedIn && authOk) {
      console.log(`[SCRAPER] Login successful — session saved to profile (${cookies.length} cookies).`);
      return { success: true, loggedIn: true, cookieCount: cookies.length };
    }
    return {
      success: false,
      loggedIn: false,
      error: 'Login was not completed (window closed or timed out before login finished).',
    };
  } catch (err) {
    try { if (context) await context.close(); } catch (_) {}
    clearLoginWaitStatus();
    return { success: false, error: err.message };
  }
}

module.exports = {
  startScrape,
  stopScrape,
  getScrapeStatus,
  parseLocalHTML,
  analyzeURL,
  getLoginWaitStatus,
  loginAndSaveSession
  ,extractAllFieldsWithAI
  ,discoverVariableFields
};
