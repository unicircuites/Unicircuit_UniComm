const axios = require('axios');
const { JSDOM } = require('jsdom');
const { chromium } = require('playwright');

const activeSessions = new Map();

// Helper to detect 2-step verification, CAPTCHAs, or robot challenge pages
async function isVerificationOrRobotPage(page) {
  try {
    const url = page.url().toLowerCase();
    
    // Check URL patterns
    const verificationUrls = ['verify', 'verification', 'challenge', 'captcha', 'mfa', '2fa', 'otp', 'robot', 'security-check', 'cloudflare', 'turnstile', 'recaptcha'];
    if (verificationUrls.some(pattern => url.includes(pattern))) {
      return true;
    }
    
    // Check page text content for verification cues
    const bodyText = (await page.textContent('body') || '').toLowerCase();
    const verificationTexts = [
      'verification code', 'verify your identity', 'two-step verification', 
      'enter the code', 'sent a code', 'one-time password', 'security code',
      'i am not a robot', 'check your phone', 'confirm your phone', 'authenticator',
      'prove you are human', 'cloudflare', 'hcaptcha', 'recaptcha', 'robot',
      'verify you are human'
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
    
    return false;
  } catch (_) {
    return false;
  }
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
      const useBrowser = (parsedCookies.length > 0) || showBrowser;
      let browserPage = null;

      if (useBrowser) {
        console.log(`[SCRAPER] Session ${sessionId}: Browser use required. Starting browser context (visible: ${showBrowser}).`);
        try {
          browserInstance = await chromium.launch({ headless: !showBrowser });
          const context = await browserInstance.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          });

          // Inject parsed cookies
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
          
          browserPage = await context.newPage();
        } catch (pwErr) {
          console.error(`[SCRAPER ERROR] Session ${sessionId}: Failed to boot Playwright browser context:`, pwErr.message);
          if (browserInstance) {
            await browserInstance.close();
            browserInstance = null;
          }
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
        try {
          // Verify URL protocol
          const parsed = new URL(targetUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('Invalid URL protocol. Target must be http or https.');
          }

          if (browserInstance && browserPage) {
            console.log(`[SCRAPER] Session ${sessionId}: Fetching URL via browser: ${targetUrl}`);
            await browserPage.goto(targetUrl, { timeout: 8000, waitUntil: 'domcontentloaded' });
            html = await browserPage.content();
          } else {
            console.log(`[SCRAPER] Session ${sessionId}: Fetching URL via static Axios: ${targetUrl}`);
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
          itemSelector,
          startSelector,
          endSelector
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
    const parsedCookies = parseCookies(cookies);

    // 2. Try utilizing Playwright for dynamic JS rendering and credential / placeholder checks
    try {
      console.log(`[SCRAPER] Analyzing URL with Playwright browser (visible: ${showBrowser}): ${url}`);
      playwrightBrowser = await chromium.launch({ headless: !showBrowser });
      const context = await playwrightBrowser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });

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
      
      // Navigate with 8-second timeout and wait for DOM loaded
      await page.goto(url, { timeout: 8000, waitUntil: 'domcontentloaded' });
      
      const currentUrl = page.url();
      
      // 1. Detect Login Wall in dynamic DOM
      const hasPasswordInput = await page.$('input[type="password"]');
      const isLoginWall = hasPasswordInput || currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('auth');
      
      if (isLoginWall) {
        console.log(`[SCRAPER] Login wall detected on ${url}. Launching headed Chrome for manual login...`);
        // Close headless browser context
        await playwrightBrowser.close();
        
        // Relaunch headed browser
        playwrightBrowser = await chromium.launch({ headless: false });
        const headedContext = await playwrightBrowser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const headedPage = await headedContext.newPage();
        
        // Go to original target URL to let user log in
        await headedPage.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
        
        // Poll and wait for login completion (up to 60 seconds)
        let loggedIn = false;
        const startTime = Date.now();
        let timeoutMs = 60000;
        let verificationDetected = false;
        
        while (Date.now() - startTime < timeoutMs) {
          await sleep(1000);
          try {
            const currentHeadedUrl = headedPage.url();
            const hasHeadedPassword = await headedPage.$('input[type="password"]');
            const isVerification = await isVerificationOrRobotPage(headedPage);
            
            if (isVerification && !verificationDetected) {
              console.log(`[SCRAPER] 2-step verification, CAPTCHA, or robot challenge detected on: ${currentHeadedUrl}`);
              console.log(`[SCRAPER] Extending manual bypass window to 3 minutes...`);
              timeoutMs = 180000; // Extend to 3 minutes
              verificationDetected = true;
            }
            
            // Check if login wall has been bypassed and not stuck on verification screen
            if (!hasHeadedPassword && 
                !currentHeadedUrl.includes('login') && 
                !currentHeadedUrl.includes('signin') && 
                !currentHeadedUrl.includes('auth') &&
                !isVerification) {
              console.log(`[SCRAPER] Login wall and verification bypassed successfully! Current URL: ${currentHeadedUrl}`);
              loggedIn = true;
              break;
            }
          } catch (pageErr) {
            console.warn('[SCRAPER WARNING] Headed browser window was closed or navigation failed.');
            break;
          }
        }
        
        if (!loggedIn) {
          await playwrightBrowser.close();
          return {
            success: false,
            url,
            error: 'Website requires login. The manual login window timed out (60s) or was closed.'
          };
        }
        
        // Bypassed! Navigate back to the original target URL under the logged-in session state
        console.log(`[SCRAPER] Reloading target URL: ${url}`);
        await headedPage.goto(url, { timeout: 10000, waitUntil: 'domcontentloaded' });
        html = await headedPage.content();
        extractedCookies = await headedContext.cookies();
        usedPlaywright = true;
        await playwrightBrowser.close();
      } else {
        // 2. Detect Placeholder/Blank Content in dynamic DOM (only if it wasn't a login wall)
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
        
        html = await page.content();
        usedPlaywright = true;
        await playwrightBrowser.close();
        console.log(`[SCRAPER] Playwright analysis successful. Loaded HTML content size: ${html.length} bytes.`);
      }
    } catch (pwErr) {
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

    // B. Detect repeating Item Containers
    let detectedItemSelector = '';
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
    const suggestedFields = [];
    const fieldMappingHelp = {};

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

    return {
      success: true,
      url,
      itemSelector: detectedItemSelector,
      pagination: detectedPagination,
      suggestedFields: suggestedFields.filter((v, i, self) => self.indexOf(v) === i), // unique
      fieldMappingHelp,
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

module.exports = {
  startScrape,
  stopScrape,
  getScrapeStatus,
  parseLocalHTML,
  analyzeURL
};
