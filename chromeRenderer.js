/**
 * chromeRenderer.js
 * ------------------------------------------------------------------
 * Renders ANY url through real, headless Chrome (via Puppeteer) so
 * that JS-rendered content, lazy-loaded images, and hydrated
 * frameworks (React/Vue/Elementor sliders, etc.) all show up in the
 * final HTML -- not just whatever a plain `fetch()` would return.
 *
 * Install:
 *   npm install puppeteer
 *
 * On some Linux hosts you may also need system libs for Chromium
 * (libnss3, libatk-bridge2.0-0, libgbm1, etc.) -- if `npm install
 * puppeteer` fails to launch, check Puppeteer's troubleshooting docs
 * for your OS.
 * ------------------------------------------------------------------
 */

const puppeteer = require('puppeteer');

/**
 * Scrolls the page in steps to trigger lazy-loaded images/content,
 * then scrolls back to top before we grab the final HTML.
 */
async function autoScroll(page, { steps = 8, delayMs = 400 } = {}) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Renders a URL in headless Chrome and returns the fully-hydrated HTML.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.waitUntil] - puppeteer navigation wait condition
 * @param {number} [options.navigationTimeoutMs]
 * @param {number} [options.extraWaitMs] - extra settle time after scroll, for late XHR/hydration
 * @param {string} [options.userAgent]
 * @param {{width:number,height:number}} [options.viewport]
 * @param {number} [options.autoScrollSteps]
 * @returns {Promise<{html: string, finalUrl: string, title: string, status: number|null}>}
 */
async function renderUrlWithChrome(url, options = {}) {
  const {
    waitUntil = 'networkidle2',
    navigationTimeoutMs = 45000,
    extraWaitMs = 1500,
    userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport = { width: 1366, height: 900 },
    autoScrollSteps = 8,
  } = options;

  if (!url || typeof url !== 'string') {
    throw new Error('renderUrlWithChrome: url must be a non-empty string');
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setViewport(viewport);

    const response = await page.goto(url, { waitUntil, timeout: navigationTimeoutMs });
    const status = response ? response.status() : null;

    // Trigger lazy-loaded images / infinite-scroll content
    await autoScroll(page, { steps: autoScrollSteps });

    if (extraWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, extraWaitMs));
    }

    const html = await page.content(); // fully rendered DOM, serialized
    const finalUrl = page.url(); // after any redirects
    const title = await page.title();

    return { html, finalUrl, title, status };
  } finally {
    await browser.close();
  }
}

module.exports = { renderUrlWithChrome };
