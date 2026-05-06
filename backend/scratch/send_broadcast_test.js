/**
 * Direct broadcast test — bypasses dashboard, uses SMTP directly
 * Run: node backend/scratch/send_broadcast_test.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const nodemailer = require('nodemailer');

const TO      = 'chinmaytriesharder7@gmail.com';
const NAME    = 'Chinmay';

const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
  .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .header { background: linear-gradient(135deg, #f5a623, #e8820a); padding: 30px 24px; text-align: center; }
  .header h1 { color: #fff; margin: 0; font-size: 24px; }
  .header p { color: rgba(255,255,255,0.85); margin: 6px 0 0; font-size: 13px; }
  .body { padding: 28px 24px; color: #333; line-height: 1.6; }
  .body h2 { color: #e8820a; margin-top: 0; }
  .highlight { background: #fff8ee; border-left: 4px solid #e8820a; padding: 12px 16px; margin: 16px 0; font-weight: bold; color: #e8820a; }
  .products { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
  .product { background: #f9f9f9; border: 1px solid #eee; border-radius: 6px; padding: 10px 14px; font-size: 13px; color: #555; }
  .cta { text-align: center; margin: 24px 0; }
  .cta a { background: #e8820a; color: #fff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 15px; }
  .footer { background: #f9f9f9; padding: 16px 24px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔌 Unicircuit Engineering Services LLP</h1>
      <p>Switchgear · VFDs · PLCs · MCC Panels · Cable Trays</p>
    </div>
    <div class="body">
      <h2>Dear ${NAME},</h2>
      <p>We hope this message finds you well. We are pleased to share our latest product offerings and a special announcement for our valued clients.</p>

      <div class="highlight">
        🎉 Special Offer: 10% off on all orders above ₹1 Lakh — Valid till 31st May 2026
      </div>

      <p><strong>Our Key Products:</strong></p>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#fff8ee;">
          <td style="padding:8px 12px;border:1px solid #eee;font-size:13px;">⚡ MCBs & MCCBs</td>
          <td style="padding:8px 12px;border:1px solid #eee;font-size:13px;">🔄 VFDs (5HP–500HP)</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #eee;font-size:13px;">🖥️ PLC Panels</td>
          <td style="padding:8px 12px;border:1px solid #eee;font-size:13px;">📦 MCC Panels</td>
        </tr>
        <tr style="background:#fff8ee;">
          <td style="padding:8px 12px;border:1px solid #eee;font-size:13px;">🔗 Cable Trays</td>
          <td style="padding:8px 12px;border:1px solid #eee;font-size:13px;">📊 Power Quality Analysers</td>
        </tr>
      </table>

      <p style="margin-top:20px;">For enquiries, quotations, or to place an order, please reach out to us:</p>
      <p>
        📧 <a href="mailto:sales@unicircuites.com" style="color:#e8820a;">sales@unicircuites.com</a><br>
        📞 +91 712 2996167 Ext. 21<br>
        🌐 <a href="https://www.unicircuites.com" style="color:#e8820a;">www.unicircuites.com</a>
      </p>

      <div class="cta">
        <a href="https://www.unicircuites.com">View Our Catalogue →</a>
      </div>
    </div>
    <div class="footer">
      Unicircuit Engineering Services LLP · Nagpur, Maharashtra, 440017, India<br>
      You received this email because you are a valued client or partner.<br>
      <a href="#" style="color:#bbb;">Unsubscribe</a>
    </div>
  </div>
</body></html>`;

async function send() {
  console.log('[SMTP] Connecting to', process.env.SMTP_HOST);
  const t = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { ciphers: 'SSLv3' },
  });

  try {
    const info = await t.sendMail({
      from:    `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM}>`,
      to:      TO,
      subject: 'Special Offer — 10% Off on Electrical Products | Unicircuit Engineering',
      html,
    });
    console.log('✅ Broadcast test sent!');
    console.log('   To:', TO);
    console.log('   Message ID:', info.messageId);
    console.log('\n📧 Check your inbox — this is what a broadcast email looks like.');
  } catch(e) {
    console.error('❌ Failed:', e.message);
  }
}

send();
