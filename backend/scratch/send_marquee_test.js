require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const nodemailer = require('nodemailer');

const TO   = 'chinmaytriesharder7@gmail.com';
const TEXT = 'UNICIRCUIT ENGINEERING SERVICES LLP — Switchgear | VFDs | PLCs | MCC Panels | Cable Trays | Power Quality Analysers — Contact: sales@unicircuites.com | +91 712 2996167 — Special Offer: 10% off on all orders above Rs. 1 Lakh this month only!';
const TC   = '#e8820a';
const BG   = '#fff8ee';

const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  @keyframes scroll { 0%{transform:translateX(100%)} 100%{transform:translateX(-100%)} }
  .scroll-text { animation: scroll 18s linear infinite; display:inline-block; white-space:nowrap; }
</style>
</head>
<body style="font-family:Arial,sans-serif;padding:20px;background:#fff;color:#333;max-width:600px;">
  <h2 style="color:#e8820a;">Marquee Big Text Test</h2>
  <p style="font-size:12px;color:#888;">Outlook: animates (18s loop) | Gmail: full text wraps to new lines</p>

  <div style="width:100%;background:${BG};border-left:4px solid ${TC};padding:10px 16px;margin:12px 0;overflow:hidden;">
    <span class="scroll-text" style="color:${TC};font-weight:bold;font-size:15px;font-family:Arial,sans-serif;white-space:normal;word-break:break-word;display:block;">
      ${TEXT}
    </span>
  </div>
</body></html>`;

nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: 587, secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { ciphers: 'SSLv3' }
}).sendMail({
  from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM}>`,
  to: TO, subject: 'Marquee Big Text Test', html
}).then(() => console.log('✅ Sent →', TO)).catch(console.error);
