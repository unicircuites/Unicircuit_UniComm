const fs = require('fs');
const file = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\dashboard.html';
let content = fs.readFileSync(file, 'utf8');

// 1. Fix waMediaHTML to handle filename extraction and captions better
const mediaHTMLTarget = /function waMediaHTML\(type, body, msgId\) \{([\s\S]*?)var cleanBody = \(body \|\| ''\)\.replace\(\/\^📷\\s\*\|\^📄\\s\*\/\, ''\)\.trim\(\);/;
const mediaHTMLReplacement = `function waMediaHTML(type, body, msgId, mediaPath) {
      var token = localStorage.getItem('unicomm_token') || '';
      var tokenParam = token ? '?token=' + encodeURIComponent(token) : '';
      var dlUrl = msgId ? (API_BASE + '/wa/media/' + msgId + tokenParam) : null;
      var cleanBody = (body || '').replace(/^📷\\s*|^📄\\s*/, '').trim();`;

content = content.replace(mediaHTMLTarget, mediaHTMLReplacement);

// Fix documentMessage block inside waMediaHTML
const docMsgTarget = /if \(type === 'documentMessage'\) \{[\s\S]*?return '<div style="background:rgba\(255,255,255,0.06\);border-radius:8px;padding:10px;margin-bottom:4px;">' \+[\s\S]*?'<div style="display:flex;align-items:center;gap:8px;font-size:13px;">📄 <span style="word-break:break-all;">' \+ fname \+ '<\/span><\/div>' \+[\s\S]*?dlLink \+ '<\/div>';\s+\}/;

const docMsgReplacement = `if (type === 'documentMessage') {
        var filename = 'Document';
        if (mediaPath && mediaPath.includes('_')) {
          filename = mediaPath.split('_').slice(1).join('_');
        } else if (cleanBody && cleanBody.includes('.') && cleanBody.length < 100) {
          filename = cleanBody;
        }

        var dlLink = dlUrl
          ? '<a href="' + dlUrl + '" download="' + filename + '" style="display:inline-flex;align-items:center;gap:6px;margin-top:8px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:6px;padding:5px 10px;font-size:11.5px;color:var(--blue2);text-decoration:none;cursor:pointer;"><i class="fas fa-download"></i> Download</a>'
          : '';
        return '<div style="background:rgba(255,255,255,0.06);border-radius:8px;padding:10px;margin-bottom:4px;">' +
          '<div style="display:flex;align-items:center;gap:8px;font-size:13px;">📄 <span style="word-break:break-all;">' + filename + '</span></div>' +
          dlLink + '</div>';
      }`;

content = content.replace(docMsgTarget, docMsgReplacement);

// 2. Fix waAppendMessage to always show caption and handle mediaPath
const appendMsgTarget1 = /var mediaBlock = waMediaHTML\(type, body, msg\.id \|\| msg\.key_id \|\| ''\);/;
const appendMsgReplacement1 = `var mediaBlock = waMediaHTML(type, body, msg.id || msg.key_id || '', msg.mediaPath || msg.media_path || '');`;
content = content.replace(appendMsgTarget1, appendMsgReplacement1);

const appendMsgTarget2 = /var bodyText = mediaBlock \? \(mediaBlock \+ \(body && type !== 'documentMessage' \? '<div style="font-size:13px;margin-top:2px;">' \+ bodyHtml \+ '<\/div>' : ''\)\) : '<div style="font-size:13px;">' \+ bodyHtml \+ '<\/div>';/;
const appendMsgReplacement2 = `// For documents, we only show the caption if it's actually a caption (different from filename)
      var showCaption = body && bodyHtml;
      if (type === 'documentMessage') {
        var filename = (msg.mediaPath || msg.media_path || '').split('_').slice(1).join('_');
        if (body === filename) showCaption = false;
      }
      var bodyText = mediaBlock ? (mediaBlock + (showCaption ? '<div style="font-size:13px;margin-top:2px;">' + bodyHtml + '</div>' : '')) : '<div style="font-size:13px;">' + bodyHtml + '</div>';`;

content = content.replace(appendMsgTarget2, appendMsgReplacement2);

fs.writeFileSync(file, content, 'utf8');
console.log('Fixed WhatsApp media rendering in dashboard.html');
