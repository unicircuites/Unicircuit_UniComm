const fs = require('fs');
const file = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\backend\\services\\whatsapp.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Improve Stability: Only clear session on explicit logout, not on all 401s
content = content.replace(/\} else if \(code === 401\) \{[\s\S]*?clearSession\(\);/g, '} else if (code === 401) { \n        console.log("[WA] Unauthorized - attempt reconnect without clearing session");');

// 2. Increase timeouts for better stability on slow networks/Windows
content = content.replace(/connectTimeoutMs: 45000,/g, 'connectTimeoutMs: 60000,');
content = content.replace(/keepAliveIntervalMs: 25000,/g, 'keepAliveIntervalMs: 30000,');

// 3. Fix getQuotedBody to show filename for documents
const quotedBodyTarget = /if \(qtype === 'extendedTextMessage'\) return ctx\.quotedMessage\.extendedTextMessage\?\.text;/;
const quotedBodyReplacement = `if (qtype === 'extendedTextMessage') return ctx.quotedMessage.extendedTextMessage?.text;
    if (qtype === 'documentMessage') return '📄 ' + (ctx.quotedMessage.documentMessage?.fileName || 'Document');`;

content = content.replace(quotedBodyTarget, quotedBodyReplacement);

fs.writeFileSync(file, content, 'utf8');
console.log('Improved WhatsApp stability and quoted document display in backend/services/whatsapp.js');
