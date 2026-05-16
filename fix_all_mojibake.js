const fs = require('fs');
const file = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\dashboard.html';
let content = fs.readFileSync(file, 'utf8');

// The mojibake is caused by UTF-8 bytes being interpreted as Windows-1252/Latin-1 characters.
// This function finds strings that look like corrupted UTF-8 (starting with ðŸ which is \u00F0\u009F)
// and properly decodes them back to actual unicode characters.

content = content.replace(/ðŸ[\s\S]{2,5}/g, match => {
  try {
    // If it's valid UTF-8 stored as latin-1, escape() encodes it to %xx%xx, then decodeURIComponent parses it!
    const decoded = decodeURIComponent(escape(match));
    if (decoded.length < match.length) return decoded; // Successfully decoded to emoji
  } catch(e) {}
  return match;
});

// Also manually fix the specific ones we know just in case
content = content.replace(/ðŸ“·/g, '📷');
content = content.replace(/ðŸŽ¥/g, '🎥');
content = content.replace(/ðŸŽµ/g, '🎵');
content = content.replace(/ðŸŽ­/g, '🎬');
content = content.replace(/ðŸ“ /g, '📍');

fs.writeFileSync(file, content, 'utf8');
console.log('Cleaned up all mojibake in dashboard.html');
