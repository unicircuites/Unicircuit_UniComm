/**
 * Matrix PBX Deep Scraper - Phase 2
 * Targets the exact URLs discovered from the menu enumeration (port 1026).
 * Focuses on: SMDR, Call Taping, VMS Config, Network Drive, Call Taping, VMS Debug
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://192.168.0.81:1026';
const REPORT = path.join(__dirname, '..', 'pbx_deep_report.txt');

// Clear report
fs.writeFileSync(REPORT, `MATRIX PBX DEEP DIAGNOSTIC REPORT\nGenerated: ${new Date()}\n${'═'.repeat(70)}\n`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(REPORT, line + '\n');
}

function section(title) {
  const line = `\n${'═'.repeat(70)}\n  ${title}\n${'═'.repeat(70)}`;
  console.log(line);
  fs.appendFileSync(REPORT, line + '\n');
}

// Pages specifically relevant to recording storage issues
const TARGET_PAGES = [
  // ── SMDR (Call Detail Records / Posting) ──────────────────────────
  { url: `${BASE}/SMDROnline.html?SubPageIndex=1`,     label: 'SMDR Online Settings' },
  { url: `${BASE}/SMDRPosting.html?SubPageIndex=1`,    label: 'SMDR Posting (IP/Port for CRM)' },
  { url: `${BASE}/SMDRStorage.html?SubPageIndex=1`,    label: 'SMDR Storage Filters' },
  { url: `${BASE}/SMDRRpt.html?SubPageIndex=1`,        label: 'SMDR Reports' },

  // ── Call Taping (the actual call recording feature) ───────────────
  { url: `${BASE}/NECallTaping.html?SubPageIndex=1`,   label: '⭐ Call Taping (Recording) Settings' },

  // ── VMS Configuration ─────────────────────────────────────────────
  { url: `${BASE}/GeneralParameters.html?SubPageIndex=1`, label: 'VMS General Parameters' },
  { url: `${BASE}/ExtensionVoiceMailSettings.html?SubPageIndex=1`, label: 'Extension Voice Mail Settings' },
  { url: `${BASE}/GeneralMailbox.html?SubPageIndex=1`, label: 'General Mailbox Settings' },
  { url: `${BASE}/MailboxStatus.html?SubPageIndex=1`,  label: 'Mailbox Status' },
  { url: `${BASE}/VmsDebug.html?SubPageIndex=1`,       label: 'VMS Debug Info' },

  // ── Network / Storage ─────────────────────────────────────────────
  { url: `${BASE}/NetworkDrive.html?SubPageIndex=1`,   label: '⭐ Network Drive (where recordings go)' },
  { url: `${BASE}/USBStatus.html?SubPageIndex=1`,      label: 'USB/Storage Status' },
  { url: `${BASE}/SysDetail.html?SubPageIndex=1`,      label: 'System Details (disk / memory)' },
  { url: `${BASE}/SysReport.html?SubPageIndex=1`,      label: 'System Usage Report' },

  // ── CTI (used for click-to-dial and call events) ──────────────────
  { url: `${BASE}/CTIPara.html?PortType=1&SubPageIndex=1`, label: 'CTI Parameters' },
  { url: `${BASE}/CTIStatus.html?SubPageIndex=1`,      label: 'CTI Status' },
];

async function scrapePageText(page, url, label) {
  section(label);
  log(`URL: ${url}`);
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    log(`Status: ${resp?.status()}`);
    await page.waitForTimeout(600);

    // Capture all input field values (the real settings)
    const fields = await page.$$eval('input, select, textarea', (els) =>
      els.map((el) => {
        const label = el.closest('tr')?.querySelector('td:first-child')?.innerText?.trim() ||
                      el.previousElementSibling?.innerText?.trim() ||
                      el.getAttribute('name') || el.getAttribute('id') || '(unnamed)';
        return {
          tag: el.tagName,
          name: el.name || el.id,
          label: label.replace(/\s+/g, ' '),
          value: el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value,
          type: el.type || '',
        };
      }).filter(f => f.name || f.value)
    ).catch(() => []);

    if (fields.length) {
      log(`  Found ${fields.length} form field(s):`);
      fields.forEach(f => log(`  [${f.type || f.tag}] "${f.label}" | name="${f.name}" | value="${f.value}"`));
    }

    // Also capture full body text for context
    const bodyText = await page.innerText('body').catch(() => '');
    const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l && l.length > 1);
    if (lines.length) {
      log(`  Page text (${lines.length} lines):`);
      lines.forEach(l => log(`    > ${l}`));
    }

    // Save screenshot
    const name = label.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    await page.screenshot({ path: path.join(__dirname, '..', `pbx_${name}.png`) });

  } catch (e) {
    log(`  ❌ Error: ${e.message}`);
  }
}

async function main() {
  log('Launching browser...');
  const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // First go to main page so session cookie is established
  await page.goto(`${BASE}/IndexNeSe.html`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});

  console.log('\n=================================================================');
  console.log('  ✋  Please LOG IN to the Matrix PBX in the browser window.');
  console.log('      Once the main dashboard loads, press ENTER here...');
  console.log('=================================================================\n');
  await new Promise((resolve) => { process.stdin.resume(); process.stdin.once('data', resolve); });
  process.stdin.pause();
  log('Login confirmed. Starting deep scrape...');

  for (const target of TARGET_PAGES) {
    await scrapePageText(page, target.url, target.label);
    await page.waitForTimeout(300);
  }

  section('DIAGNOSIS COMPLETE');
  log(`Full report: ${REPORT}`);
  log('Keeping browser open for 30s...');
  await page.waitForTimeout(30000);
  await browser.close();
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
