const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'dashboard.html');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Restore broken openEmail logic
const brokenSection = `        const wrapped = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
          'html,body{height:100%;margin:0;padding:12px;box-sizing:border-box;background:#ffffff!important;color:#1a1a1a;' +
          'font-family:\\'Segoe UI\\',Outfit,sans-serif;font-size:13px;line-height:1.65;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;}' +
          'img{max-width:100%;height:auto;}' +
          '</style></head><body>' + htmlSrc + '</body></html>';

  } catch (err) {`;

const fixedSection = `        const wrapped = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
          'html,body{height:100%;margin:0;padding:12px;box-sizing:border-box;background:#ffffff!important;color:#1a1a1a;' +
          'font-family:\\'Segoe UI\\',Outfit,sans-serif;font-size:13px;line-height:1.65;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;}' +
          'img{max-width:100%;height:auto;}' +
          '</style></head><body>' + htmlSrc + '</body></html>';
        const blob = new Blob([wrapped], { type: 'text/html;charset=utf-8' });
        outlookEmailBlobUrl = URL.createObjectURL(blob);
        bodyEl.innerHTML = '<iframe id="email-body-frame" sandbox="allow-same-origin" src="' + outlookEmailBlobUrl + '" title="Email body"></iframe>';
      } else {
        const esc = String(raw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        bodyEl.innerHTML = '<div class="email-plain-scroll"><pre style="white-space:pre-wrap;font-family:\\'Outfit\\',sans-serif;font-size:13px;color:' + wrapFg + ';margin:0;">' + esc + '</pre></div>';
      }
    }
    // Show reply buttons
    ['btn-reply','btn-reply-all','btn-assign-reply','btn-ai-reply'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'inline-flex';
    });
    renderMailTasksPanel();
    // Pre-fill compose To field
    const replyTo = msg.from?.emailAddress?.address || '';
    const toEl = document.getElementById('compose-to');
    if (toEl && replyTo) toEl.value = replyTo;

  } catch (err) {`;

if (content.includes(brokenSection)) {
    content = content.replace(brokenSection, fixedSection);
    console.log('Fixed openEmail section.');
} else {
    console.log('Broken openEmail section not found.');
}

// 2. Fix resetComposeForm
const brokenReset = `function resetComposeForm() {
  ['compose-to', 'compose-cc', 'compose-subject'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const body = document.getElementById('compose-body');
  if (body) body.innerHTML = '';
  const s = document.getElementById('compose-status');
  if (s) s.style.display = 'none';
}`;

const fixedReset = `function resetComposeForm() {
  ['compose-to', 'compose-cc', 'compose-subject'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const body = document.getElementById('compose-body');
  if (body) {
    body.innerHTML = '';
    body.contentEditable = "true";
  }
  const s = document.getElementById('compose-status');
  if (s) s.style.display = 'none';

  // Clear any existing unknown sender banner
  const banner = document.querySelector('.reply-unknown-banner');
  if (banner) banner.remove();
}`;

if (content.includes(brokenReset)) {
    content = content.replace(brokenReset, fixedReset);
    console.log('Fixed resetComposeForm.');
} else {
    console.log('brokenReset not found.');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('dashboard.html updated.');
