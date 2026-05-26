const fs = require('fs');
const acorn = require('acorn');

const html = fs.readFileSync('dashboard.html', 'utf8');
const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

let match;
let count = 0;
while ((match = scriptRegex.exec(html)) !== null) {
  count++;
  const scriptContent = match[1];
  try {
    acorn.parse(scriptContent, { ecmaVersion: 2022, sourceType: 'script' });
  } catch (e) {
    console.log(`Error in script block ${count}:`, e.message);
    const lines = scriptContent.split('\n');
    console.log(`Error at line ${e.loc.line}, column ${e.loc.column}`);
    console.log(lines[e.loc.line - 1]);
  }
}
console.log('Done checking ' + count + ' scripts.');
