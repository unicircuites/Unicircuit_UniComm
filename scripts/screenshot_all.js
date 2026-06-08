/**
 * UniComm Pro — Screenshot All Sections
 * Opens Chrome visibly → you login → script detects dashboard → auto-starts screenshots
 * Run: node scripts/screenshot_all.js
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const BASE = 'http://localhost:8088';
const OUT  = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
fs.readdirSync(OUT).filter(f => f.endsWith('.png')).forEach(f => fs.unlinkSync(path.join(OUT, f)));

async function shot(page, name, note) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ✅ ${name}.png${note ? '  — ' + note : ''}`);
}

async function navTo(page, tab) {
  await page.evaluate((t) => {
    const el = document.querySelector(`.nav-item[onclick*="'${t}'"]`);
    if (el) el.click();
  }, tab);
  await page.waitForTimeout(2500);
}

(async () => {
  console.log('\n🚀 UniComm Pro Screenshot Suite');
  console.log(`\n🌐 Opening browser at ${BASE}/login.html`);
  console.log('   → Login with: admin@unicircuit.com / Admin@1234');
  console.log('   → Script will AUTO-START once dashboard loads...\n');

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--start-maximized'],
  });

  const ctx  = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });

  // ── Wait until dashboard.html is loaded (you login manually) ──────────────
  console.log('⏳ Waiting for you to login...');
  await page.waitForURL('**/dashboard.html', { timeout: 120000 }); // 2 min timeout
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000); // let dashboard fully render

  console.log('✅ Dashboard detected! Starting screenshots...\n');

  const token = await page.evaluate(() =>
    localStorage.getItem('uc_token') || sessionStorage.getItem('uc_token') || ''
  );

  // ── 01 Dashboard ──────────────────────────────────────────────────────────
  await navTo(page, 'dashboard');
  await shot(page, '01_dashboard', 'KPI cards');

  // ── 02 PBX Call Logs ──────────────────────────────────────────────────────
  await navTo(page, 'calls');
  await shot(page, '02_pbx_calls', 'call log table');
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(400);
  await shot(page, '03_pbx_calls_bottom', 'call log lower rows');
  await page.evaluate(() => window.scrollTo(0, 0));

  // ── 03 Email / Outlook ────────────────────────────────────────────────────
  await navTo(page, 'email');
  await shot(page, '04_email_inbox', 'Outlook inbox');
  const firstEmail = await page.$('.email-row, .mail-item, tr[onclick*="mail"]');
  if (firstEmail) {
    await firstEmail.click();
    await page.waitForTimeout(1500);
    await shot(page, '05_email_detail', 'email thread detail');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // ── 04 WhatsApp ───────────────────────────────────────────────────────────
  await navTo(page, 'whatsapp');
  await shot(page, '06_whatsapp_chatlist', 'WA chat list');
  const firstChat = await page.$('.chat-item, .wa-chat-row, [onclick*="openChat"]');
  if (firstChat) {
    await firstChat.click();
    await page.waitForTimeout(1500);
    await shot(page, '07_whatsapp_messages', 'WA conversation');
  }

  // ── 05 Contacts ───────────────────────────────────────────────────────────
  await navTo(page, 'contacts');
  await shot(page, '08_contacts', 'CRM contacts list');
  const addBtn = await page.$('button:has-text("Add"), button:has-text("New Contact")');
  if (addBtn) {
    await addBtn.click();
    await page.waitForTimeout(800);
    await shot(page, '09_contacts_add', 'add contact modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // ── 06 Pipeline ───────────────────────────────────────────────────────────
  await navTo(page, 'pipeline');
  await shot(page, '10_pipeline', 'sales pipeline');

  // ── 07 Marketing Suite ────────────────────────────────────────────────────
  await navTo(page, 'marketing');
  await shot(page, '11_marketing', 'marketing overview');

  for (const kw of ['broadcast', 'template', 'campaign', 'group']) {
    const found = await page.evaluate((kw) => {
      const el = [...document.querySelectorAll('button, .tab, li, [onclick]')]
        .find(e => e.textContent.trim().toLowerCase().includes(kw));
      if (el) { el.click(); return true; }
      return false;
    }, kw);
    if (found) {
      await page.waitForTimeout(1500);
      await shot(page, `12_mkt_${kw}`, `marketing ${kw}`);
    }
  }

  // ── 08 AI Assistant ───────────────────────────────────────────────────────
  await navTo(page, 'ai');
  await shot(page, '13_ai_assistant', 'AI panel');

  // ── 09 Analytics ──────────────────────────────────────────────────────────
  await navTo(page, 'analytics');
  await shot(page, '14_analytics', 'analytics');

  // ── 10 System status ──────────────────────────────────────────────────────
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[onclick], button')]
      .find(e => /system|status|health/i.test(e.textContent + (e.getAttribute('onclick') || '')));
    if (el) el.click();
  });
  await page.waitForTimeout(1200);
  await shot(page, '15_system_status', 'system health');

  // ── API responses ──────────────────────────────────────────────────────────
  console.log('\n[API] Capturing API responses...\n');
  const apis = [
    ['api_01_health',         '/api/health'],
    ['api_02_stats',          '/api/dashboard/stats'],
    ['api_03_calls',          '/api/calls?limit=5'],
    ['api_04_contacts',       '/api/contacts?limit=5'],
    ['api_05_pipeline',       '/api/pipeline'],
    ['api_06_campaigns',      '/api/campaigns'],
    ['api_07_broadcasts',     '/api/broadcast'],
    ['api_08_templates',      '/api/templates'],
    ['api_09_groups',         '/api/groups'],
    ['api_10_system',         '/api/system/status'],
    ['api_11_pbx_status',     '/api/calls/pbx-status'],
    ['api_12_outlook_status', '/api/outlook/status'],
    ['api_13_wa_chats',       '/api/whatsapp/chats'],
  ];
  for (const [name, ep] of apis) {
    try {
      const ap = await ctx.newPage();
      if (token) await ap.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
      await ap.goto(`${BASE}${ep}`, { waitUntil: 'domcontentloaded', timeout: 6000 });
      await ap.waitForTimeout(400);
      await ap.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      await ap.close();
      console.log(`  ✅ ${name}.png`);
    } catch (e) {
      console.log(`  ⚠️  ${name} — ${e.message.slice(0, 50)}`);
    }
  }

  await browser.close();

  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png'));
  console.log(`\n✅ DONE! ${files.length} screenshots → ${OUT}\n`);
  files.forEach(f => console.log(`   📸 ${f}`));
})();
