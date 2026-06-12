const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'dashboard.html');
const content = fs.readFileSync(htmlPath, 'utf8');

console.log('File size:', content.length, 'bytes');

// Find script tags
console.log('\n--- Script tags/src attributes ---');
const scriptSrcRegex = /<script\b[^>]*src="([^"]+)"/gi;
let match;
while ((match = scriptSrcRegex.exec(content)) !== null) {
  console.log('Script src:', match[1]);
}

// Find inline script content length and position
console.log('\n--- Inline Scripts ---');
const inlineScriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let index = 0;
let inlineMatch;
while ((inlineMatch = inlineScriptRegex.exec(content)) !== null) {
  const code = inlineMatch[1];
  if (!inlineMatch[0].includes('src=')) {
    console.log(`Inline Script #${index++}: length ${code.length} bytes, starts with: ${code.trim().substring(0, 150).replace(/\n/g, ' ')}...`);
    // Search for API calls inside this script
    const apiCalls = code.match(/[\/\w\-]+api\/[\/\w\-]+/g);
    if (apiCalls) {
      console.log('   Potential API calls:', Array.from(new Set(apiCalls)));
    }
  }
}

// Search for KPI card structure in the HTML
console.log('\n--- Search for KPI Elements/IDs/Classes ---');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('id="') && (line.includes('stat') || line.includes('kpi') || line.includes('count') || line.includes('total') || line.includes('call') || line.includes('wa') || line.includes('email'))) {
    if (line.length < 200) {
      console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
  }
});
