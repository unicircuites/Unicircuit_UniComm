const fs = require('fs');

const path = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\dashboard.html';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  // Outlook / Disconnected Error
  { regex: /Disconnected â.{0,3}Œ/g, replacement: 'Disconnected ❌' },
  { regex: /\[OUTLOOK\] â.{0,3}Œ Not connected/g, replacement: '[OUTLOOK] ❌ Not connected' },
  { regex: /textContent = 'â.{0,3}Œ Not connected'/g, replacement: "textContent = '❌ Not connected'" },
  { regex: /\[OUTLOOK\] â.{0,3}Œ Check status error:/g, replacement: '[OUTLOOK] ❌ Check status error:' },
  { regex: /â.{0,3}Œ \[Outlook Contacts\]/g, replacement: '❌ [Outlook Contacts]' },
  { regex: /â.{0,3}Œ \[Outlook Sync\]/g, replacement: '❌ [Outlook Sync]' },
  
  // Connected / Disconnected dots
  { regex: />â.{0,3}— Connected</g, replacement: '>● Connected<' },
  { regex: />â.{0,3}— Disconnected</g, replacement: '>● Disconnected<' },
  
  // Service Icons
  { regex: /postgres: 'ðŸ—„ï¸ ', system: 'âš™ï¸ '/g, replacement: "postgres: '🗄️', system: '⚙️'" },
  
  // PBX
  { regex: /\[PBX\] â.{0,3}Œ SOCKET EVENT/g, replacement: '[PBX] ❌ SOCKET EVENT' },
  { regex: /â• â•  PBX CONTACT SAVE MODAL â• â• /g, replacement: '══ PBX CONTACT SAVE MODAL ══' },
  
  // Inbox Fallback
  { regex: /\[Inbox\] â.{0,3}Œ DB fallback also failed/g, replacement: '[Inbox] ❌ DB fallback also failed' },
  { regex: /\[Inbox\] âš ï¸  Force offline/g, replacement: '[Inbox] ⚠️ Force offline' },
  { regex: /\[EMAIL-SEND\] âš  No stored HTML/g, replacement: '[EMAIL-SEND] ⚠️ No stored HTML' },
  
  // Emoji Tabs
  { regex: /âœˆï¸ <\/button>/g, replacement: '✈️</button>' },
  { regex: /â ¤ï¸ <\/button>/g, replacement: '❤️</button>' },
  
  // AI Timer
  { regex: /\[AI\] â.{0,3}± Analysis started/g, replacement: '[AI] ⏱ Analysis started' },
  { regex: /â.{0,3}± Elapsed:/g, replacement: '⏱ Elapsed:' },
  { regex: /\[AI\] â.{0,3}± Running/g, replacement: '[AI] ⏱ Running' },
  { regex: /\[AI\] â.{0,3}Œ Error:/g, replacement: '[AI] ❌ Error:' },
  { regex: /\[AI-TEST\] â.{0,3}Œ Failed:/g, replacement: '[AI-TEST] ❌ Failed:' },
  { regex: /â†  start elapsed counter/g, replacement: '← start elapsed counter' },
  { regex: /â†  stop counter/g, replacement: '← stop counter' },
  
  // Inbox mailto icon
  { regex: /'âœ‰ï¸  <a href="mailto:'/g, replacement: "'✉️ <a href=\"mailto:'" },
  
  // Long comment dividers
  { regex: /\/\/ â• â• â• â• â• â• .*/g, replacement: '// ════════════════════════════════════════════════' },
  { regex: /\[Inbox\] â• â• â• â• â• .*/g, replacement: '[Inbox] ════════════════════════════════════════════════' }
];

let totalReplaced = 0;

replacements.forEach(r => {
  const matches = content.match(r.regex);
  if (matches) {
    totalReplaced += matches.length;
    content = content.replace(r.regex, r.replacement);
  }
});

// Also fix the main Sidebar Navigation Mojibake if any exists (just in case)
const sidebarFixes = [
  { target: 'â˜Žï¸ ', replacement: '☎️' },
  { target: 'âœ‰ï¸ ', replacement: '✉️' },
  { target: 'ðŸ“ˆ', replacement: '📈' },
  { target: 'ðŸ“„', replacement: '📄' },
  { target: 'âš™ï¸ ', replacement: '⚙️' },
  { target: 'ðŸ—„ï¸ ', replacement: '🗄️' },
  { target: 'ðŸ“ž', replacement: '📞' }
];

sidebarFixes.forEach(r => {
  if (content.includes(r.target)) {
    content = content.split(r.target).join(r.replacement);
    totalReplaced++;
  }
});

fs.writeFileSync(path, content, 'utf8');

console.log('Successfully completed ' + totalReplaced + ' text replacements across dashboard.html! The UI is now completely clean.');
