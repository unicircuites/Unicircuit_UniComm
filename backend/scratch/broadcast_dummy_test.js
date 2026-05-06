/**
 * Broadcast dummy test — 100 fake emails
 * Most will fail (invalid domains) — tests delivery tracking
 * Run: node backend/scratch/broadcast_dummy_test.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../db/pool');
const eb   = require('../services/emailBroadcast');

// Generate 100 dummy recipients — mix of invalid + 1 real
const dummies = [];
const names = ['Rahul','Priya','Amit','Sneha','Vijay','Pooja','Ravi','Anita','Suresh','Meena',
  'Arun','Kavita','Deepak','Sunita','Manoj','Rekha','Sanjay','Geeta','Rajesh','Usha',
  'Nitin','Lata','Vinod','Asha','Prakash','Nisha','Ramesh','Sita','Ajay','Radha',
  'Mohan','Puja','Sunil','Mala','Dinesh','Shanti','Anil','Vimla','Harish','Kamla',
  'Girish','Sarla','Mahesh','Pushpa','Naresh','Savita','Umesh','Kiran','Yogesh','Sudha'];

for (let i = 1; i <= 99; i++) {
  const name = names[(i-1) % names.length] + ' ' + i;
  // Mix of fake domains — will all fail SMTP delivery
  const domains = ['fakecorp.invalid','testmail.xyz','dummy.nowhere','notreal.test','example.fake'];
  const domain = domains[i % domains.length];
  dummies.push({ name, email: `user${i}@${domain}` });
}
// 1 real email at position 50
dummies.splice(49, 0, { name: 'Chinmay (Real)', email: 'chinmaytriesharder7@gmail.com' });

const subject = 'Broadcast Delivery Test — Unicircuit Engineering';
const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;padding:20px;background:#fff;color:#333;max-width:600px;">
  <div style="background:linear-gradient(135deg,#f5a623,#e8820a);padding:20px;border-radius:8px 8px 0 0;text-align:center;">
    <h2 style="color:#fff;margin:0;">Unicircuit Engineering Services LLP</h2>
    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:13px;">Broadcast Delivery Test</p>
  </div>
  <div style="padding:20px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
    <p>Dear <strong>{{name}}</strong>,</p>
    <p>This is a test broadcast email to verify delivery tracking functionality in UniComm Pro.</p>
    <p>If you received this email, the broadcast system is working correctly.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
    <p style="font-size:11px;color:#999;">
      Sent via UniComm Pro · noreply@unicircuites.live<br>
      Recipient #{{index}} of 100
    </p>
  </div>
</body></html>`;

async function run() {
  console.log(`[Broadcast] Starting test with ${dummies.length} recipients...`);
  console.log('[Broadcast] 99 fake emails (will fail) + 1 real (chinmaytriesharder7@gmail.com)');
  console.log('[Broadcast] Delay: 100ms between each (fast test)\n');

  // Save to DB
  let broadcastId;
  try {
    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const result = await pool.query(
      `INSERT INTO email_broadcasts (subject, html_body, recipients, from_email, total, status)
       VALUES ($1,$2,$3,$4,$5,'sending') RETURNING id`,
      [subject, html, JSON.stringify(dummies), fromEmail, dummies.length]
    );
    broadcastId = result.rows[0].id;
    console.log(`[Broadcast] Created broadcast #${broadcastId} in DB`);
  } catch(e) {
    console.error('[DB] Error:', e.message);
    process.exit(1);
  }

  // Send with progress
  let lastLog = 0;
  const results = await eb.sendBroadcast(dummies, subject, html,
    function(sent, failed, current) {
      const total = sent + failed;
      if (total - lastLog >= 10 || total === dummies.length) {
        console.log(`  Progress: ${total}/${dummies.length} — sent:${sent} failed:${failed} | last: ${current}`);
        lastLog = total;
      }
    },
    100 // 100ms delay for fast test
  );

  // Update DB
  await pool.query(
    `UPDATE email_broadcasts SET sent=$1, failed=$2, status='sent', sent_at=NOW(), errors=$3, deliveries=$4 WHERE id=$5`,
    [results.sent, results.failed, JSON.stringify(results.errors), JSON.stringify(results.deliveries), broadcastId]
  );

  console.log(`\n[Broadcast #${broadcastId}] Complete!`);
  console.log(`  ✅ Sent:   ${results.sent}`);
  console.log(`  ❌ Failed: ${results.failed}`);
  console.log(`  📋 Total:  ${dummies.length}`);
  console.log('\nOpen dashboard → Marketing Suite → Email Broadcast → click "Broadcast Delivery Test" to see per-recipient timestamps.');

  await pool.end();
}

run().catch(console.error);
