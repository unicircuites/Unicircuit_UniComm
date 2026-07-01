// Lead Web Scraper utility routes.
//
// These endpoints are pure scraping helpers used by the dashboard UI. They were
// previously only reachable under /api/crm, which is gated by machine-to-machine
// CRM_AGENT_TOKENS auth — so the browser (which sends the user's login JWT, not an
// agent token) got "Missing or invalid CRM agent bearer token". They live here on
// /api/scraper so the dashboard can call them directly.

const express = require('express');
const router = express.Router();
const scraperService = require('../services/scraperService');

router.post('/analyze', async (req, res, next) => {
  try {
    const { url, cookies, showBrowser } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required.' });
    const analysis = await scraperService.analyzeURL(url, cookies, showBrowser);
    return res.json(analysis);
  } catch (err) {
    next(err);
  }
});

router.get('/analyze/login-status', async (req, res, next) => {
  try {
    return res.json(scraperService.getLoginWaitStatus());
  } catch (err) {
    next(err);
  }
});

// Open the persistent Chrome profile so the user can log in once; the session is
// saved to the profile on close and reused by later analyze/scrape runs.
// Long-running (waits for manual login) — disable the socket timeout.
router.post('/login', async (req, res, next) => {
  req.setTimeout(0);
  res.setTimeout(0);
  try {
    const { url } = req.body || {};
    const result = await scraperService.loginAndSaveSession(url);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
});

// Transcribe a single reel's audio to an "audio script" (+ published date).
// Long-running (opens browser, downloads media, runs Whisper) — no socket timeout.
router.post('/reel-transcript', async (req, res, next) => {
  req.setTimeout(0);
  res.setTimeout(0);
  try {
    const { reel_url: reelUrl } = req.body || {};
    if (!reelUrl) return res.status(400).json({ error: 'reel_url is required.' });
    const result = await scraperService.transcribeReel(reelUrl);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/start', async (req, res, next) => {
  try {
    const sessionId = req.body.sessionId || 'session_' + Date.now();
    const session = await scraperService.startScrape(sessionId, req.body);
    return res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

router.post('/stop', async (req, res, next) => {
  try {
    const sessionId = req.body.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
    const session = scraperService.stopScrape(sessionId);
    if (!session) return res.status(404).json({ error: 'Scraper session not found.' });
    return res.json(session);
  } catch (err) {
    next(err);
  }
});

router.get('/status', async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
    const session = scraperService.getScrapeStatus(sessionId);
    if (!session) return res.status(404).json({ error: 'Scraper session not found.' });
    return res.json(session);
  } catch (err) {
    next(err);
  }
});

router.post('/upload-html', async (req, res, next) => {
  try {
    const { html, fields, options } = req.body;
    if (!html) return res.status(400).json({ error: 'html content is required.' });
    const fieldsArr = Array.isArray(fields) ? fields : (fields || 'name,email').split(',').map(f => f.trim()).filter(Boolean);
    const parsed = scraperService.parseLocalHTML(html, fieldsArr, options || {});
    return res.json(parsed);
  } catch (err) {
    next(err);
  }
});

router.post('/extract-all', async (req, res) => {
  try {
    const { sourceType, url, html, mode, selectedFieldsByType } = req.body || {};
    const result = await scraperService.extractAllFieldsWithAI({
      sourceType,
      url,
      html,
      mode: mode === 'discover' ? 'discover' : 'extract',
      selectedFieldsByType: selectedFieldsByType || null,
    });
    return res.json(result);
  } catch (err) {
    const message = err.message || 'Extraction failed.';
    const isClientError = /paste html|enter a target url|invalid url|login|verification|readable html|fetch failed|select at least one/i.test(message);
    console.warn('[SCRAPER] extract-all failed:', message);
    return res.status(isClientError ? 400 : 500).json({ error: message });
  }
});

router.post('/discover-fields', async (req, res) => {
  try {
    const { sourceType, url, html } = req.body || {};
    const result = await scraperService.discoverVariableFields({ sourceType, url, html });
    return res.json(result);
  } catch (err) {
    const message = err.message || 'Field discovery failed.';
    const isClientError = /paste html|enter a target url|invalid url|login|verification|readable html|fetch failed/i.test(message);
    console.warn('[SCRAPER] discover-fields failed:', message);
    return res.status(isClientError ? 400 : 500).json({ error: message });
  }
});

module.exports = router;
