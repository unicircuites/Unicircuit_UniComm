/**
 * Matrix PBX Admin Panel Scraper
 * Purpose: Extract VMS / Voice Recording / SMDR / FTP settings to diagnose
 *          why call recordings are not being stored after recent calls.
 *
 * Usage:
 *   node scripts/pbx_scraper.js
 *
 * The script will open a VISIBLE browser window so you can log in.
 * Once you are logged in and the dashboard is visible, press ENTER in this
 * terminal to start the automated scraping.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PBX_URL = 'http://192.168.0.81:80/IndexNeSe.html';
const REPORT_FILE = path.join(__dirname, '..', 'pbx_vms_report.txt');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(REPORT_FILE, line + '\n');
}

function section(title) {
  const bar = '═'.repeat(60);
  const line = `\n${bar}\n  ${title}\n${bar}`;
  console.log(line);
  fs.appendFileSync(REPORT_FILE, line + '\n');
}

// Helper: extract all visible text/value pairs from a frame
async function scrapeFormData(frame, label) {
  try {
    const rows = await frame.$$eval(
      'table tr, .field-row, form div',
      (els) => els.map((el) => el.innerText?.replace(/\s+/g, ' ').trim()).filter(Boolean)
    );
    if (rows.length) {
      log(`[${label}] Scraped ${rows.length} rows`);
      rows.forEach((r) => log(`  > ${r}`));
    } else {
      log(`[${label}] No table rows found — trying generic text`);
      const text = await frame.innerText('body').catch(() => '');
      text.split('\n').filter(l => l.trim()).forEach(l => log(`  > ${l.trim()}`));
    }
  } catch (e) {
    log(`[${label}] Error scraping frame: ${e.message}`);
  }
}

// Helper: navigate via menu in any frame and scrape the resulting content frame
async function navigateMenu(page, frameLocator, menuText, subMenuText) {
  log(`Navigating: ${menuText} → ${subMenuText || '(direct click)'}`);
  try {
    const frame = await page.frame({ name: frameLocator }) || page.frames().find(f => f.name() === frameLocator);
    if (!frame) {
      log(`  ⚠️  Frame "${frameLocator}" not found. Available frames: ${page.frames().map(f => f.name()).join(', ')}`);
      return;
    }

    const menuItem = frame.locator(`text=${menuText}`).first();
    if (await menuItem.count()) {
      await menuItem.click();
      await page.waitForTimeout(600);
    } else {
      log(`  ⚠️  Menu item "${menuText}" not found`);
      return;
    }

    if (subMenuText) {
      const subItem = frame.locator(`text=${subMenuText}`).first();
      if (await subItem.count()) {
        await subItem.click();
        await page.waitForTimeout(800);
      } else {
        log(`  ⚠️  Sub-menu item "${subMenuText}" not found`);
        return;
      }
    }

    // Scrape the main content frame (usually the rightmost/largest frame)
    const contentFrame = page.frames().find(f => f.name() === 'MainFrame' || f.name() === 'main' || f.name() === 'content') || page.frames()[page.frames().length - 1];
    await scrapeFormData(contentFrame, `${menuText} > ${subMenuText || ''}`);
  } catch (e) {
    log(`Navigation error: ${e.message}`);
  }
}

async function main() {
  // Clear previous report
  fs.writeFileSync(REPORT_FILE, `MATRIX PBX VMS DIAGNOSTIC REPORT\nGenerated: ${new Date()}\n${'═'.repeat(60)}\n`);

  log('Launching browser — a window will appear for you to log in.');
  const browser = await chromium.launch({
    headless: false,
    args: ['--ignore-certificate-errors'],
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  log(`Navigating to PBX: ${PBX_URL}`);
  await page.goto(PBX_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

  // Wait for user to log in
  console.log('\n=========================================================');
  console.log('  ✋  Please LOG IN to the Matrix PBX in the browser.');
  console.log('      Once the main dashboard / menu is visible,');
  console.log('      come back here and press ENTER to continue...');
  console.log('=========================================================\n');
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
  process.stdin.pause();
  log('User confirmed login. Starting automated scrape...');

  // ── STEP 1: Enumerate all frames ──────────────────────────────────
  section('STEP 1: Frameset Enumeration');
  const frames = page.frames();
  log(`Total frames detected: ${frames.length}`);
  for (const f of frames) {
    log(`  Frame name="${f.name()}" url="${f.url()}"`);
  }

  // Try to identify menu frame and content frame by URL patterns or name
  const menuFrame  = frames.find(f => /menu|left|nav/i.test(f.name()) || /menu|left|nav/i.test(f.url())) || frames[1];
  const mainFrame  = frames.find(f => /main|right|content|body/i.test(f.name()) || /main|right|content/i.test(f.url())) || frames[frames.length - 1];

  log(`Using menu frame: name="${menuFrame?.name()}" url="${menuFrame?.url()}"`);
  log(`Using main frame: name="${mainFrame?.name()}" url="${mainFrame?.url()}"`);

  // ── STEP 2: Take screenshot of current state ───────────────────────
  section('STEP 2: Screenshot');
  const ssPath = path.join(__dirname, '..', 'pbx_screenshot.png');
  await page.screenshot({ path: ssPath, fullPage: true });
  log(`Screenshot saved to: ${ssPath}`);

  // ── STEP 3: Scrape all visible menu links ──────────────────────────
  section('STEP 3: Menu Link Discovery');
  if (menuFrame) {
    const links = await menuFrame.$$eval('a', (as) =>
      as.map((a) => ({ text: a.innerText.trim(), href: a.href })).filter((l) => l.text)
    );
    log(`Found ${links.length} menu links:`);
    links.forEach((l) => log(`  [LINK] "${l.text}" → ${l.href}`));
  }

  // ── STEP 4: VMS / Voicemail Settings ──────────────────────────────
  section('STEP 4: Voicemail / VMS Settings');
  // Try direct URL navigation to known Matrix VMS pages
  const vmsPages = [
    '/VmSystem.html',
    '/VmsSystemSettings.html',
    '/VmExtension.html',
    '/VmEmailFtp.html',
    '/VmFtpSettings.html',
    '/FtpServer.html',
    '/VoicemailFtp.html',
    '/FtpSettings.html',
    '/VmsEmailFtp.html',
  ];

  for (const pg of vmsPages) {
    const testUrl = `http://192.168.0.81:80${pg}`;
    log(`\nProbing: ${testUrl}`);
    try {
      const resp = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 6000 });
      if (resp && resp.status() < 400) {
        log(`  ✅ Page loaded (status ${resp.status()})`);
        await page.waitForTimeout(500);
        // Scrape all text from the page
        const content = await page.innerText('body').catch(() => '');
        content.split('\n').filter(l => l.trim()).forEach(l => log(`  > ${l.trim()}`));
        await page.screenshot({ path: path.join(__dirname, '..', `pbx_vms_${pg.replace(/\//g, '_')}.png`) });
      } else {
        log(`  ❌ Not found (status ${resp?.status()})`);
      }
    } catch (e) {
      log(`  ❌ Error: ${e.message}`);
    }
  }

  // ── STEP 5: Return to main PBX page and probe SMDR settings ────────
  section('STEP 5: SMDR / Call Recording Settings');
  await page.goto(PBX_URL, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const smdrPages = [
    '/SmdrOnline.html',
    '/SmdrSettings.html',
    '/Smdr.html',
    '/CdrSettings.html',
    '/CallRecord.html',
    '/Recording.html',
    '/VoiceRecord.html',
    '/AutoRecord.html',
  ];

  for (const pg of smdrPages) {
    const testUrl = `http://192.168.0.81:80${pg}`;
    log(`\nProbing: ${testUrl}`);
    try {
      const resp = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 6000 });
      if (resp && resp.status() < 400) {
        log(`  ✅ Page loaded (status ${resp.status()})`);
        await page.waitForTimeout(500);
        const content = await page.innerText('body').catch(() => '');
        content.split('\n').filter(l => l.trim()).forEach(l => log(`  > ${l.trim()}`));
        await page.screenshot({ path: path.join(__dirname, '..', `pbx_smdr_${pg.replace(/\//g, '_')}.png`) });
      } else {
        log(`  ❌ Not found (status ${resp?.status()})`);
      }
    } catch (e) {
      log(`  ❌ Error: ${e.message}`);
    }
  }

  // ── STEP 6: Scrape all input values from any open frame ────────────
  section('STEP 6: All Form Field Capture (Current Page State)');
  await page.goto(PBX_URL, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);

  for (const frame of page.frames()) {
    try {
      const inputs = await frame.$$eval('input, select, textarea', (els) =>
        els.map((el) => ({
          type: el.type || el.tagName,
          name: el.name || el.id,
          value: el.value || el.innerText,
          checked: el.checked,
        }))
      );
      if (inputs.length) {
        log(`Frame "${frame.name()}" inputs:`);
        inputs.forEach((i) => log(`  [${i.type}] name="${i.name}" value="${i.value}" checked=${i.checked}`));
      }
    } catch (_) {}
  }

  section('SCRAPE COMPLETE');
  log(`Full report saved to: ${REPORT_FILE}`);
  log('Browser will stay open for 60 seconds so you can review...');

  await page.waitForTimeout(60000);
  await browser.close();
}

main().catch((err) => {
  log(`FATAL ERROR: ${err.message}`);
  process.exit(1);
});
