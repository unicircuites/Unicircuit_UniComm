const fs = require('fs');
const file = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\dashboard.html';
let content = fs.readFileSync(file, 'utf8');

// 1. Refine waAppendMessage to be smarter about document captions and filenames
const appendMsgTarget = /\/\/ For documents, we only show the caption if it's actually a caption \(different from filename\)[\s\S]*?var bodyText = mediaBlock \? \(mediaBlock \+ \(showCaption \? '<div style="font-size:13px;margin-top:2px;">' \+ bodyHtml \+ '<\/div>' : ''\)\) : '<div style="font-size:13px;">' \+ bodyHtml \+ '<\/div>';/;

const appendMsgReplacement = `// Robust Document Handling: Prevent duplicate filename display when no caption is present
      var showCaption = !!bodyHtml;
      if (type === 'documentMessage') {
        var inferredFilename = 'Document';
        var mPath = msg.mediaPath || msg.media_path || '';
        if (mPath && mPath.includes('_')) {
          inferredFilename = mPath.split('_').slice(1).join('_');
        } else if (body && body.includes('.') && body.length < 100) {
          inferredFilename = body;
        }
        
        // If the body is identical to the filename (clean or raw), don't show it as a caption
        var cleanInferred = inferredFilename.replace(/^📷\\s*|^📄\\s*/, '').trim();
        var cleanBody = (body || '').replace(/^📷\\s*|^📄\\s*/, '').trim();
        if (cleanBody === cleanInferred || body === inferredFilename) {
          showCaption = false;
        }
      }
      var bodyText = mediaBlock ? (mediaBlock + (showCaption ? '<div style="font-size:13px;margin-top:2px;">' + bodyHtml + '</div>' : '')) : '<div style="font-size:13px;">' + bodyHtml + '</div>';`;

content = content.replace(appendMsgTarget, appendMsgReplacement);

fs.writeFileSync(file, content, 'utf8');
console.log('Permanently fixed document filename/caption duplication in dashboard.html');
