const fs = require('fs');
const file = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\dashboard.html';
let content = fs.readFileSync(file, 'utf8');

const target = /async function waSendMsg\(\) \{[\s\S]*?catch \(err\) \{ notify\('Send failed', err\.message, 'var\(--red\)', 'fas fa-exclamation-circle'\); \}\s+\}/;

const replacement = `async function waSendMsg() {
      var input = document.getElementById('wa-msg-input');
      var text = input.value.trim();
      var jid = waActiveJid;
      if (!jid) return;
      if (!text && !waSelectedMedia) return;

      var quotedId = waReplyTo ? waReplyTo.id : null;
      var quotedBody = waReplyTo ? waReplyTo.body : null;

      if (waSelectedMedia) {
        waAppendMessage({ 
          fromMe: true, 
          body: text || waSelectedMedia.name, 
          ts: new Date(), 
          type: waSelectedMedia.type.startsWith('image/') ? 'imageMessage' : (waSelectedMedia.type.startsWith('video/') ? 'videoMessage' : 'documentMessage'),
          quotedBody: quotedBody
        });
      } else {
        waAppendMessage({ fromMe: true, body: text, ts: new Date(), quotedBody: quotedBody });
      }

      input.value = '';
      waCancelReply();
      
      try {
        if (waSelectedMedia) {
          const reader = new FileReader();
          const fileToUpload = waSelectedMedia;
          const mediaCaption = text;
          waCancelMedia();

          reader.onload = async function(e) {
            const base64 = e.target.result;
            let mediaType = 'document';
            if (fileToUpload.type.startsWith('image/')) mediaType = 'image';
            else if (fileToUpload.type.startsWith('video/')) mediaType = 'video';

            const payload = {
              jid: jid,
              fileName: fileToUpload.name,
              mimeType: fileToUpload.type,
              mediaType: mediaType,
              data: base64,
              caption: mediaCaption,
              quotedMsgId: quotedId
            };

            const res = await fetch(API_BASE + '/wa/send-media', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(payload) });
            if (!res.ok) {
              const data = await res.json();
              notify('Media send failed', data.error || 'Unknown error', 'var(--red)', 'fas fa-exclamation-circle');
            }
          };
          reader.readAsDataURL(fileToUpload);
        } else {
          await fetch(API_BASE + '/wa/send', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ jid: jid, message: text, quotedMsgId: quotedId }) });
        }

        var chat = waAllChats.find(function (c) { return c.id === jid; });
        if (chat) { 
          chat.last_message = waSelectedMedia ? (text || 'Media Message') : text; 
          chat.last_time = new Date(); 
          waRenderChats(waAllChats); 
        }
      } catch (err) { 
        notify('Send failed', err.message, 'var(--red)', 'fas fa-exclamation-circle'); 
      }
    }`;

content = content.replace(target, replacement);

fs.writeFileSync(file, content, 'utf8');
console.log('Successfully updated waSendMsg in dashboard.html');
