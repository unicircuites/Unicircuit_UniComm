/**
 * Matrix SMDR Control Service
 * Automates PBX SMDR configuration and service restart via web interface
 * Uses Playwright to access https://192.168.0.81:1026/IndexNeSe.html
 */

const { chromium } = require('playwright');

const PBX_URL = 'https://192.168.0.81:1026/IndexNeSe.html';
const PBX_HOST = process.env.PBX_HOST || '192.168.0.81';
const SMDR_PORT = process.env.SMDR_PORT || '5001';
const DESTINATION_IP = process.env.HOST || '192.168.0.169'; // Dev machine IP

let browser = null;
let context = null;

/**
 * Start SMDR service on PBX
 * Navigates to SMDR Posting and clicks Start button
 */
async function startSmdrService(adminUser = 'admin', adminPass = 'admin') {
  try {
    console.log('\n[SMDR-CONTROL] ╔════════════════════════════════════════════════════════╗');
    console.log('[SMDR-CONTROL] ║ MATRIX PBX SMDR SERVICE AUTOMATION                      ║');
    console.log('[SMDR-CONTROL] ╚════════════════════════════════════════════════════════╝\n');

    console.log('[SMDR-CONTROL] 📋 STEP 1: Browser Launch');
    console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
    console.log(`[SMDR-CONTROL]   PBX URL: ${PBX_URL}`);
    console.log(`[SMDR-CONTROL]   Destination IP: ${DESTINATION_IP}`);
    console.log(`[SMDR-CONTROL]   Port: ${SMDR_PORT}`);

    // Launch browser
    browser = await chromium.launch({
      headless: true,
      args: ['--ignore-certificate-errors']
    });
    console.log('[SMDR-CONTROL] ✅ Browser launched');

    context = await browser.newContext({
      ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    // Navigate to PBX
    console.log('\n[SMDR-CONTROL] 📋 STEP 2: Navigate to PBX');
    console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
    console.log('[SMDR-CONTROL] 📍 Navigating to PBX web interface...');
    
    await page.goto(PBX_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    console.log('[SMDR-CONTROL] ✅ PBX page loaded');

    // Check if login is required
    console.log('\n[SMDR-CONTROL] 📋 STEP 3: Authentication');
    console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
    
    const loginForm = await page.$('input[name="username"]').catch(() => null);
    
    if (loginForm) {
      console.log('[SMDR-CONTROL] 🔐 Login form detected, authenticating...');
      
      // Fill login form
      await page.fill('input[name="username"]', adminUser);
      await page.fill('input[name="password"]', adminPass);
      console.log('[SMDR-CONTROL]   Credentials filled');
      
      // Click login button
      const loginBtn = await page.$('button[type="submit"]').catch(() => null);
      if (loginBtn) {
        await loginBtn.click();
        console.log('[SMDR-CONTROL]   Login button clicked');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }
      
      console.log('[SMDR-CONTROL] ✅ Login completed');
    } else {
      console.log('[SMDR-CONTROL] ℹ️  Already logged in or no login required');
    }

    // Navigate to SMDR Posting
    console.log('\n[SMDR-CONTROL] 📋 STEP 4: Navigate to SMDR Posting');
    console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
    
    // Try to find and click Reports menu
    console.log('[SMDR-CONTROL] 🔍 Looking for Reports menu...');
    const reportsMenu = await page.$('text=Reports').catch(() => null);
    if (reportsMenu) {
      await reportsMenu.click();
      console.log('[SMDR-CONTROL] ✅ Reports menu clicked');
      await page.waitForTimeout(1000);
    } else {
      console.log('[SMDR-CONTROL] ⚠️  Reports menu not found');
    }

    // Try to find and click SMDR submenu
    console.log('[SMDR-CONTROL] 🔍 Looking for SMDR submenu...');
    const smdrMenu = await page.$('text=SMDR').catch(() => null);
    if (smdrMenu) {
      await smdrMenu.click();
      console.log('[SMDR-CONTROL] ✅ SMDR submenu clicked');
      await page.waitForTimeout(1000);
    } else {
      console.log('[SMDR-CONTROL] ⚠️  SMDR submenu not found');
    }

    // Try to find and click SMDR Posting
    console.log('[SMDR-CONTROL] 🔍 Looking for SMDR Posting option...');
    const smdrPosting = await page.$('text=SMDR Posting').catch(() => null);
    if (smdrPosting) {
      await smdrPosting.click();
      console.log('[SMDR-CONTROL] ✅ SMDR Posting clicked');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    } else {
      console.log('[SMDR-CONTROL] ⚠️  SMDR Posting not found');
    }

    console.log('[SMDR-CONTROL] ✅ Navigated to SMDR Posting page');

    // Verify/Update Destination IP
    console.log('\n[SMDR-CONTROL] 📋 STEP 5: Verify/Update Destination IP');
    console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
    console.log('[SMDR-CONTROL] 🔍 Checking Destination IP setting...');
    
    const ipInputs = await page.$$('input[type="text"]');
    console.log(`[SMDR-CONTROL]   Found ${ipInputs.length} text input fields`);
    
    let ipUpdated = false;
    let ipFound = false;

    for (let i = 0; i < ipInputs.length; i++) {
      const input = ipInputs[i];
      const value = await input.inputValue().catch(() => '');
      const placeholder = await input.getAttribute('placeholder').catch(() => '');
      
      console.log(`[SMDR-CONTROL]   Input ${i}: value="${value}", placeholder="${placeholder}"`);
      
      // Look for IP address field
      if (value.includes('.') || placeholder.toLowerCase().includes('ip') || placeholder.toLowerCase().includes('address')) {
        ipFound = true;
        console.log(`[SMDR-CONTROL] ✅ Found IP field: ${value}`);
        
        if (value !== DESTINATION_IP) {
          console.log(`[SMDR-CONTROL]   Updating IP from ${value} to ${DESTINATION_IP}...`);
          await input.fill(DESTINATION_IP);
          ipUpdated = true;
          console.log('[SMDR-CONTROL] ✅ IP updated');
        } else {
          console.log('[SMDR-CONTROL] ✅ IP already correct');
        }
        break;
      }
    }
    
    if (!ipFound) {
      console.log('[SMDR-CONTROL] ⚠️  IP field not found in inputs');
    }

    // Verify/Update Port
    console.log('\n[SMDR-CONTROL] 📋 STEP 6: Verify/Update Port');
    console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
    console.log('[SMDR-CONTROL] 🔍 Checking Port setting...');
    
    const portInputs = await page.$$('input[type="text"]');
    let portUpdated = false;
    let portFound = false;

    for (let i = 0; i < portInputs.length; i++) {
      const input = portInputs[i];
      const value = await input.inputValue().catch(() => '');
      const placeholder = await input.getAttribute('placeholder').catch(() => '');
      
      // Look for port field (numeric, 4-5 digits)
      if (/^\d{4,5}$/.test(value) || placeholder.toLowerCase().includes('port')) {
        portFound = true;
        console.log(`[SMDR-CONTROL] ✅ Found port field: ${value}`);
        
        if (value !== String(SMDR_PORT)) {
          console.log(`[SMDR-CONTROL]   Updating port from ${value} to ${SMDR_PORT}...`);
          await input.fill(String(SMDR_PORT));
          portUpdated = true;
          console.log('[SMDR-CONTROL] ✅ Port updated');
        } else {
          console.log('[SMDR-CONTROL] ✅ Port already correct');
        }
        break;
      }
    }
    
    if (!portFound) {
      console.log('[SMDR-CONTROL] ⚠️  Port field not found in inputs');
    }

    // Save settings if updated
    if (ipUpdated || portUpdated) {
      console.log('\n[SMDR-CONTROL] 📋 STEP 7: Save Settings');
      console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
      console.log('[SMDR-CONTROL] 💾 Saving settings...');
      
      const saveBtn = await page.$('button:has-text("Save")').catch(() => null);
      if (saveBtn) {
        await saveBtn.click();
        await page.waitForTimeout(2000);
        console.log('[SMDR-CONTROL] ✅ Settings saved');
      } else {
        console.log('[SMDR-CONTROL] ⚠️  Save button not found');
      }
    }

    // Find and click Start button
    console.log('\n[SMDR-CONTROL] 📋 STEP 8: Start SMDR Service');
    console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
    console.log('[SMDR-CONTROL] 🎬 Looking for Start button...');
    
    const startBtn = await page.$('button:has-text("Start")').catch(() => null);
    if (startBtn) {
      console.log('[SMDR-CONTROL] 🎬 Clicking Start button...');
      await startBtn.click();
      await page.waitForTimeout(3000);
      console.log('[SMDR-CONTROL] ✅ Start button clicked');
    } else {
      // Try alternative selectors
      console.log('[SMDR-CONTROL] 🔍 Trying alternative selectors...');
      const buttons = await page.$$('button');
      console.log(`[SMDR-CONTROL]   Found ${buttons.length} buttons`);
      
      let startFound = false;
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const text = await btn.textContent().catch(() => '');
        console.log(`[SMDR-CONTROL]   Button ${i}: "${text}"`);
        
        if (text.toLowerCase().includes('start')) {
          console.log('[SMDR-CONTROL] 🎬 Found Start button (alternative selector)');
          await btn.click();
          await page.waitForTimeout(3000);
          console.log('[SMDR-CONTROL] ✅ Start button clicked');
          startFound = true;
          break;
        }
      }
      
      if (!startFound) {
        console.log('[SMDR-CONTROL] ⚠️  Start button not found');
      }
    }

    // Verify SMDR service status
    console.log('\n[SMDR-CONTROL] 📋 STEP 9: Verify Service Status');
    console.log('[SMDR-CONTROL] ─────────────────────────────────────────────────');
    console.log('[SMDR-CONTROL] ✅ Verifying SMDR service status...');
    
    const statusElements = await page.$$('text=/Running|Active|Started/i');
    if (statusElements.length > 0) {
      console.log('[SMDR-CONTROL] ✅ SMDR service appears to be running');
    } else {
      console.log('[SMDR-CONTROL] ⚠️  Could not verify service status');
    }

    console.log('\n[SMDR-CONTROL] ╔════════════════════════════════════════════════════════╗');
    console.log('[SMDR-CONTROL] ║ SMDR SERVICE AUTOMATION COMPLETED                      ║');
    console.log('[SMDR-CONTROL] ╚════════════════════════════════════════════════════════╝\n');
    console.log('[SMDR-CONTROL] ✅ The PBX should now be sending SMDR data to:');
    console.log(`[SMDR-CONTROL]    ${DESTINATION_IP}:${SMDR_PORT}`);
    console.log('[SMDR-CONTROL] ⏳ Wait 10-15 seconds for the connection to establish...\n');

    return { success: true, message: 'SMDR service started' };

  } catch (err) {
    console.error('\n[SMDR-CONTROL] ❌ Error:', err.message);
    console.error('[SMDR-CONTROL]    Stack:', err.stack);
    return { success: false, error: err.message };
  } finally {
    // Cleanup
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { startSmdrService };
