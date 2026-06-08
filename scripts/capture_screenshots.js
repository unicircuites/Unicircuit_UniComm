/**
 * UniComm Pro — Interactive Screenshot Capture
 * Uses your real installed Chrome (visible window).
 * YOU log in manually, then press ENTER in this terminal to start capture.
 *
 * Run: node scripts/capture_screenshots.js
 */

const puppeteer = require('puppeteer');
const readline  = require('readline');
const fs        = require('fs');
const path      = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────
const BASE_URL = 'http://localhost:8088';

// Common Chrome paths on Windows — first one found is used
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chromium.exe',
];

function findChrome() {
  for (const p of CHROME_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null; // fallback: let puppeteer use its own bundled browser
}

const TS      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.join(__dirname, '..', 'screenshots', `capture_${TS}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

let seq = 0;
const nextSeq = () => String(++seq).padStart(3, '0');

// ── HELPERS ───────────────────────────────────────────────────────────────
async function shot(page, label) {
  const safe = label.replace(/[^\w\- ]/g, '_').replace(/\s+/g, '_');
  const file = path.join(OUT_DIR, `${nextSeq()}_${safe}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  📸  ${path.basename(file)}`);
  return file;
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// Wait for user to press ENTER in terminal
function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// Call the app's nav() function to switch sections
async function goNav(page, section) {
  try {
    await page.evaluate((sec) => {
      if (typeof nav === 'function') {
        const items = document.querySelectorAll('.nav-item');
        let found = null;
        items.forEach(el => {
          const oc = el.getAttribute('onclick') || '';
          if (oc.includes(`'${sec}'`) || oc.includes(`"${sec}"`)) found = el;
        });
        nav(sec, found);
      }
    }, section);
    await wait(1500);
    return true;
  } catch (e) {
    console.log(`  ⚠️  goNav('${section}') failed: ${e.message}`);
    return false;
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   UniComm Pro — Interactive Screenshot Capture       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const chromePath = findChrome();
  if (chromePath) {
    console.log(`🟢  Chrome found: ${chromePath}`);
  } else {
    console.log('⚠️   System Chrome not found — using Puppeteer bundled browser');
  }

  console.log(`📂  Screenshots will be saved to:`);
  console.log(`    ${OUT_DIR}\n`);

  const launchOptions = {
    headless: false,           // ← REAL visible Chrome window
    defaultViewport: null,     // ← Use full window size (not capped)
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
    ],
  };

  if (chromePath) {
    launchOptions.executablePath = chromePath;
  }

  const browser = await puppeteer.launch(launchOptions);
  const [page]  = await browser.pages();

  // Set a good viewport for screenshots
  await page.setViewport({ width: 1440, height: 900 });

  // Open login page
  console.log(`🌐  Opening: ${BASE_URL}/login.html`);
  await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'networkidle0', timeout: 15000 });

  // ── MANUAL LOGIN STEP ────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('👆  Please log in to the app in the Chrome window that just opened.');
  console.log('    Make sure you reach the main DASHBOARD before pressing Enter.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await waitForEnter('   ✅  Press ENTER when you are on the Dashboard... ');

  console.log('\n🚀  Starting screenshot capture...\n');

  // Screenshot the login page from history is gone — capture current state
  // Take screenshot of current state (should be dashboard)
  await wait(1000);

  try {
    // ━━━ 01: Login page (go back briefly, then return) ━━━━━━━━━━━━━━━━━━
    console.log('[01] Login Page');
    const currentUrl = page.url();
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'networkidle0', timeout: 10000 });
    await wait(600);
    await shot(page, '01_Login_Page');
    // Go back to dashboard
    await page.goto(currentUrl || `${BASE_URL}/dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await wait(3000);

    // ━━━ 02: Dashboard ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[02] Dashboard Overview');
    await goNav(page, 'dashboard');
    await wait(2500);
    await shot(page, '02_Dashboard_Overview');

    // Full dashboard scroll
    await page.evaluate(() => window.scrollTo(0, 300));
    await wait(600);
    await shot(page, '02b_Dashboard_Middle');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await wait(600);
    await shot(page, '02c_Dashboard_Bottom');
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(400);

    // ━━━ 03: Sidebar ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[03] Sidebar Navigation');
    await shot(page, '03_Sidebar_Navigation');

    // ━━━ 04: PBX Call Logs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[04] PBX Call Logs');
    await goNav(page, 'calls');
    await wait(2500);
    await shot(page, '04_PBX_Call_Logs');

    await page.evaluate(() => { if (typeof pbxShowTab === 'function') pbxShowTab('recordings', null); });
    await wait(1500);
    await shot(page, '04b_PBX_Recordings_Tab');

    await page.evaluate(() => { if (typeof pbxShowTab === 'function') pbxShowTab('backup', null); });
    await wait(1500);
    await shot(page, '04c_PBX_Backup_Tab');

    await page.evaluate(() => { if (typeof pbxShowTab === 'function') pbxShowTab('logs', null); });
    await wait(800);

    // ━━━ 05: Email / Outlook ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[05] Email / Outlook');
    await goNav(page, 'email');
    await wait(3000);
    await shot(page, '05_Email_Outlook_Inbox');

    // Sent items
    await page.evaluate(() => {
      const sentEl = document.getElementById('tab-sent');
      if (typeof switchFolder === 'function') switchFolder('sent', sentEl);
    });
    await wait(1800);
    await shot(page, '05b_Email_Outlook_Sent');

    // Inbox again
    await page.evaluate(() => {
      const el = document.getElementById('tab-inbox');
      if (typeof switchFolder === 'function') switchFolder('inbox', el);
    });
    await wait(1000);

    // Open first email if available
    await page.evaluate(() => {
      const first = document.querySelector('.email-item, .mail-item, .message-row');
      if (first) first.click();
    });
    await wait(1500);
    await shot(page, '05c_Email_Detail_View');

    // Contacts tab
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('.outlook-tab, [onclick*="Contacts"], [onclick*="directory"]');
      tabs.forEach(t => { if ((t.textContent || '').toLowerCase().includes('contact')) t.click(); });
    });
    await wait(1500);
    await shot(page, '05d_Email_Outlook_Contacts');

    // Backup tab
    await page.evaluate(() => {
      if (typeof showBackupTab === 'function') showBackupTab('saved');
    });
    await wait(1500);
    await shot(page, '05e_Email_Outlook_Backup');

    // ━━━ 06: WhatsApp ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[06] WhatsApp');
    await goNav(page, 'whatsapp');
    await wait(3000);
    await shot(page, '06_WhatsApp_Chat_List');

    // Click first chat
    await page.evaluate(() => {
      const chat = document.querySelector('.chat-item, .wa-chat-item, [data-jid], .chat-row');
      if (chat) chat.click();
    });
    await wait(2000);
    await shot(page, '06b_WhatsApp_Chat_Open');

    // ━━━ 07: Contacts ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[07] Contacts');
    await goNav(page, 'contacts');
    await wait(2500);
    await shot(page, '07_Contacts_List');

    // First contact card detail
    await page.evaluate(() => {
      const card = document.querySelector('.contact-card, .contact-row');
      if (card) card.click();
    });
    await wait(1200);
    await shot(page, '07b_Contact_Detail');
    await page.keyboard.press('Escape');
    await wait(400);

    // Add contact
    await page.evaluate(() => {
      const btn = document.querySelector('[onclick*="addContact"], [onclick*="newContact"], .btn-green, .btn-primary');
      if (btn) btn.click();
    });
    await wait(1000);
    await shot(page, '07c_Contacts_Add_Modal');
    await page.keyboard.press('Escape');
    await wait(400);

    // ━━━ 08: Pipeline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[08] Sales Pipeline');
    await goNav(page, 'pipeline');
    await wait(2500);
    await shot(page, '08_Sales_Pipeline');

    await page.evaluate(() => {
      const btn = document.querySelector('[onclick*="addDeal"], [onclick*="newDeal"], .btn-green');
      if (btn) btn.click();
    });
    await wait(1000);
    await shot(page, '08b_Pipeline_Add_Deal');
    await page.keyboard.press('Escape');
    await wait(400);

    // ━━━ 09: Marketing Suite ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[09] Marketing Suite');
    await goNav(page, 'marketing');
    await wait(2000);
    await shot(page, '09_Marketing_Suite');

    // Marketing sub-tabs
    const mktTabs = await page.$$('.marketing-tab, .tab-btn, [onclick*="bcShowTab"], [onclick*="mktTab"]');
    for (let i = 0; i < Math.min(mktTabs.length, 4); i++) {
      await mktTabs[i].click();
      await wait(1000);
      const tabLabel = await mktTabs[i].evaluate(el => (el.textContent || '').trim().replace(/\s+/g, '_'));
      await shot(page, `09${String.fromCharCode(98 + i)}_Marketing_${tabLabel || 'Tab_' + (i+1)}`);
    }

    // ━━━ 10: AI Assistant ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[10] AI Assistant');
    await goNav(page, 'ai');
    await wait(2000);
    await shot(page, '10_AI_Assistant');

    // Type a sample message
    const aiInputEl = await page.$('#aiInput, textarea.ai-input, .ai-chat-input textarea, [placeholder*="Ask"], [placeholder*="message"]');
    if (aiInputEl) {
      await aiInputEl.type("What are our top open deals this week?", { delay: 35 });
      await wait(500);
      await shot(page, '10b_AI_Query_Typed');
      await aiInputEl.evaluate(el => el.value = '');
    }

    // ━━━ 11: Analytics ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[11] Analytics');
    await goNav(page, 'analytics');
    await wait(2500);
    await shot(page, '11_Analytics');

    // ━━━ 12: Activity log / System state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[12] Dashboard Activity & System Status');
    await goNav(page, 'dashboard');
    await wait(2500);
    await shot(page, '12_Dashboard_Refreshed');

    // Service health pills in header
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(400);
    await shot(page, '12b_Service_Health_Header');

    // ━━━ 13: API responses (open as new tab, keep session cookies) ━━━━━━━
    console.log('[13] API Responses');
    const token = await page.evaluate(() =>
      localStorage.getItem('authToken') || localStorage.getItem('token') || ''
    );

    const apiEndpoints = [
      { url: '/api/wa/status',       label: '13a_API_WA_Status' },
      { url: '/api/system/status',   label: '13b_API_System_Status' },
      { url: '/api/dashboard/stats', label: '13c_API_Dashboard_Stats' },
      { url: '/api/calls?limit=5',   label: '13d_API_Call_Logs' },
      { url: '/api/health',          label: '13e_API_Health' },
    ];

    for (const ep of apiEndpoints) {
      await page.evaluate(async (base, t, endpoint) => {
        try {
          const r = await fetch(`${base}${endpoint}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
          const d = await r.json();
          document.body.innerHTML = `
            <div style="background:#0d1117;color:#58a6ff;font-family:monospace;font-size:13px;
                        padding:24px;min-height:100vh;white-space:pre-wrap;line-height:1.6;">
              <div style="color:#f0883e;font-size:16px;margin-bottom:12px;">GET ${endpoint}</div>
              ${JSON.stringify(d, null, 2)}
            </div>`;
        } catch(e) {
          document.body.innerHTML = `<pre style="color:red;padding:20px;">${e.message}</pre>`;
        }
      }, BASE_URL, token, ep.url);
      await wait(500);
      await shot(page, ep.label);
    }

    // ━━━ 14: Full page dashboard screenshot ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('[14] Full-Page Dashboard');
    await page.goto(`${BASE_URL}/dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await wait(4000);
    const fpFile = path.join(OUT_DIR, `${nextSeq()}_14_Dashboard_Full_Page.png`);
    await page.screenshot({ path: fpFile, fullPage: true });
    console.log(`  📸  ${path.basename(fpFile)}`);

  } catch (err) {
    console.error('\n❌  Error during capture:', err.message);
    try { await shot(page, 'ERROR_STATE'); } catch (_) {}
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png'));
  console.log(`\n✅  Capture complete!`);
  console.log(`📸  ${files.length} screenshots saved to:`);
  console.log(`    ${OUT_DIR}\n`);
  files.forEach(f => console.log(`    • ${f}`));

  await waitForEnter('\n   Press ENTER to close the Chrome window...');
  await browser.close();
})();
