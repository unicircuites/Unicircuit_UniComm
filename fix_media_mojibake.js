const fs = require('fs');
const file = 'c:\\Users\\unius\\Documents\\code workout\\UNI_CRM\\dashboard.html';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/ðŸ“·/g, '📷');

fs.writeFileSync(file, content, 'utf8');
console.log('Fixed remaining mojibake in dashboard.html');
