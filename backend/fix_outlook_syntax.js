const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'routes', 'outlook.js');
let content = fs.readFileSync(filePath, 'utf8');

// Show lines around 3100 (0-indexed: 3099)
const lines = content.split('\n');
for (let i = 3096; i <= 3103; i++) {
  console.log(`Line ${i+1}: ${JSON.stringify(lines[i])}`);
}

// Fix: replace the broken template literal
// Bad:  `[AI] Analyzing email: "${email.subject || '(no subject)'"}"`
// Good: `[AI] Analyzing email: "${email.subject || '(no subject)'}"`
const broken  = `\`[AI] Analyzing email: "\${email.subject || '(no subject)'\"}"\``;
const fixed   = `\`[AI] Analyzing email: "\${email.subject || '(no subject)'}"\``;

if (content.includes(broken)) {
  content = content.replace(broken, fixed);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('\n✅ Fixed! Stray quote removed from template literal on ~line 3100.');
} else {
  console.log('\n⚠️  Pattern not found — please check the printed lines above and fix manually.');
}
