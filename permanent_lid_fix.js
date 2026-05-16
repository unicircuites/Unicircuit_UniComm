const fs = require('fs');

// --- BACKEND FIX ---
const waServiceFile = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\backend\\services\\whatsapp.js';
if (fs.existsSync(waServiceFile)) {
    let waContent = fs.readFileSync(waServiceFile, 'utf8');

    // Fix getBody to not return LID for documentMessages
    waContent = waContent.replace(
        /case 'documentMessage':\s+return msg\.message\.documentMessage\?\.caption \|\| msg\.message\.documentMessage\?\.fileName \|\| 'Document';/,
        "case 'documentMessage': return msg.message.documentMessage?.caption || msg.message.documentMessage?.fileName || 'Document';"
    );

    // Fix saveMessage to strictly filter out LIDs from senderName and senderPhone
    const saveMsgTarget = /if \(resolved && !\/\\\+?\\\d\[\\\d\\\s\]\+\/\.test\(resolved\)\) \{[\s\S]*?senderName = resolved;[\s\S]*?\} else if \(msg\.pushName && msg\.pushName\.trim\(\)\) \{/;
    const saveMsgReplacement = `if (resolved && !/^\\+?\\d[\\d\\s]+$/.test(resolved)) {
        senderName = resolved;
      } else if (msg.pushName && msg.pushName.trim()) {
        senderName = msg.pushName.trim();
        // If pushName looks like a LID (15+ digits), suppress it
        if (/^\\d{15,}$/.test(senderName)) senderName = null;`;
    
    waContent = waContent.replace(saveMsgTarget, saveMsgReplacement);

    fs.writeFileSync(waServiceFile, waContent, 'utf8');
    console.log('Fixed backend LID filtering in whatsapp.js');
}

// --- FRONTEND FIX ---
const dashboardFile = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\dashboard.html';
if (fs.existsSync(dashboardFile)) {
    let dashContent = fs.readFileSync(dashboardFile, 'utf8');

    // 1. Fix replaceLidMentions to be more aggressive and handle missing mappings
    const lidMentionsTarget = /function replaceLidMentions\(text\) \{[\s\S]*?return match;[\s\S]*?\}\);[\s\S]*?\}/;
    const lidMentionsReplacement = `function replaceLidMentions(text) {
        if (!text || !text.includes('@')) return text;
        return text.replace(/@\\+?(\\d{7,25})/g, function (match, num) {
          var entry = waLidMap[num];
          if (entry && entry.name && !entry.name.startsWith('+')) return '@' + entry.name;
          if (entry && entry.phone) return '@' + entry.phone;
          
          var chat = waAllChats ? waAllChats.find(function (ch) {
            return ch.id && ch.id.startsWith(num + '@');
          }) : null;
          if (chat && chat.name && !chat.name.startsWith('+')) return '@' + chat.name;
          if (chat && chat.phone) return '@' + chat.phone;

          // Permanent Fix: If it's 15+ digits and unresolvable, it's a LID. Hide it.
          if (num.length >= 15) return ''; 
          return match;
        });
      }`;
    dashContent = dashContent.replace(lidMentionsTarget, lidMentionsReplacement);

    // 2. Fix sender label in waAppendMessage to suppress LIDs
    const senderPhoneTarget = /senderPhone = msg\.senderPhone \|\| msg\.sender_phone \|\| '';/;
    const senderPhoneReplacement = `senderPhone = msg.senderPhone || msg.sender_phone || '';
        // LID Suppression: Never show 15+ digit IDs as phone numbers
        if (senderPhone && senderPhone.replace(/\\D/g, '').length >= 15) senderPhone = '';`;
    
    dashContent = dashContent.replace(senderPhoneTarget, senderPhoneReplacement);

    fs.writeFileSync(dashboardFile, dashContent, 'utf8');
    console.log('Fixed frontend LID suppression in dashboard.html');
}

// --- DATABASE CLEANUP ---
const pool = require('./backend/db/pool');
async function cleanupDB() {
    try {
        // Remove LID numbers that were mistakenly saved as phone numbers
        const res = await pool.query("UPDATE wa_contacts SET phone = NULL WHERE phone ~ '^[0-9]{15,}$'");
        console.log(`Cleaned up ${res.rowCount} LID entries from wa_contacts`);
        
        // Also fix wa_chats names if they are just LID numbers
        const res2 = await pool.query("UPDATE wa_chats SET name = phone WHERE name ~ '^[0-9]{15,}$' AND phone IS NOT NULL");
        console.log(`Cleaned up ${res2.rowCount} LID entries from wa_chats`);
    } catch (err) {
        console.error('Database cleanup error:', err.message);
    } finally {
        process.exit();
    }
}
cleanupDB();
