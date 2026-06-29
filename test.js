const l = {
  notes: 'Source: outlook | Confidence: high\n---\n<html><head></head><body><h1>Hello</h1></body></html>'
};

const escHtml = (s) => s;
const escAttr = (s) => s;

const html = (() => {
  if (!l.notes) return '';
  let actualNotes = l.notes;
  let mailSnippet = '';
  if (l.notes.includes('\n---\n')) {
    const parts = l.notes.split('\n---\n');
    actualNotes = parts[0];
    mailSnippet = parts.slice(1).join('\n---\n');
  }
  
  let html = '';
  const isHtml = (str) => {
    const s = str.trim().toLowerCase();
    return s.startsWith('<html') || s.startsWith('<!doctype html>') || s.startsWith('<div') || s.startsWith('<meta');
  };

  if (isHtml(actualNotes)) {
     const uidNotes = 'lead-notes-123';
     html += `<div style="margin-bottom:6px;"><div style="font-size:10.5px;color:var(--muted);margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px;">Notes</div><iframe id="${uidNotes}" class="email-body-iframe" style="width:100%;height:350px;border:1px solid var(--border);border-radius:8px;background:#fff;" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-scripts"></iframe></div>`;
  } else {
     html += `<div style="margin-bottom:6px;"><div style="font-size:10.5px;color:var(--muted);margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px;">Notes</div><div style="font-size:12.5px;color:var(--text);background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;padding:10px;line-height:1.6;white-space:pre-wrap;">${escHtml(actualNotes)}</div></div>`;
  }
  
  if (mailSnippet) {
    let snippetPreview = '';
    if (isHtml(mailSnippet)) {
        const uid = 'lead-mail-456';
        snippetPreview = `<iframe id="${uid}" class="email-body-iframe" style="width:100%;height:400px;border:1px solid var(--border);border-radius:4px;background:#fff;margin-top:8px;display:block;" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-scripts"></iframe>`;
    } else {
        snippetPreview = `<div class="outlook-session-preview" style="white-space:pre-wrap;font-size:12px;margin-top:4px;">${escHtml(mailSnippet)}</div>`;
    }
    html += `
      <div class="outlook-session-card" style="margin-top:12px;cursor:default;">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <i class="fas fa-envelope" style="color:#0078d4;margin-top:2px;"></i>
          <div style="min-width:0;flex:1;">
            <div class="outlook-session-title">Email Content Snapshot</div>
            ${snippetPreview}
          </div>
        </div>
      </div>
    `;
  }
  return html;
})();

console.log(html);
