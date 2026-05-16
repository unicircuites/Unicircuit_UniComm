const fs = require('fs');

const file = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\dashboard.html';
let content = fs.readFileSync(file, 'utf8');

const target1 = /\/\/ Replace @LID_numbers with @Name using waAllChats data[\s\S]*?return match;\s+\}\);\s+\}/;
const replacement1 = `      function replaceLidMentions(text) {
        if (!text || !text.includes('@')) return text;
        return text.replace(/@\\+?(\\d{7,20})/g, function (match, num) {
          var entry = waLidMap[num];
          if (entry && entry.name && !entry.name.startsWith('+')) return '@' + entry.name;
          if (entry && entry.phone) return '@' + entry.phone;
          
          var chat = waAllChats ? waAllChats.find(function (ch) {
            return ch.id && ch.id.startsWith(num + '@');
          }) : null;
          if (chat && chat.name && !chat.name.startsWith('+')) return '@' + chat.name;
          if (chat && chat.phone) return '@' + chat.phone;
          return match;
        });
      }

      body = replaceLidMentions(body);`;

content = content.replace(target1, replacement1);

const target2 = /var quotedBody = msg\.quotedBody \|\| msg\.quoted_body \|\| '';/;
const replacement2 = `var quotedBody = replaceLidMentions(msg.quotedBody || msg.quoted_body || '');`;

content = content.replace(target2, replacement2);

fs.writeFileSync(file, content, 'utf8');
console.log('done!');
