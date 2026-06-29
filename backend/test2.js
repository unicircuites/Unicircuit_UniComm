require('dotenv').config({ path: './.env' });
const scraperService = require('./services/scraperService');

(async () => {
  try {
    const res = await scraperService.extractAllFieldsWithAI({
      sourceType: 'manual_html',
      html: '<html><body><div>Test</div></body></html>'
    });
    console.log('SUCCESS:', res);
  } catch (err) {
    console.error('FAILED:', err.stack);
  }
})();
