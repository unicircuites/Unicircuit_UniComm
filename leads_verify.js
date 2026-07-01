const puppeteer = require('./node_modules/puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox'] });
  const page = (await browser.pages())[0] || await browser.newPage();
  const dbg = [];
  page.on('console', m => { const t=m.text(); if(/\[Leads/i.test(t)) dbg.push('['+m.type()+'] '+t); });
  page.on('pageerror', e => dbg.push('[PAGEERROR] '+e.message.slice(0,200)));
  await page.goto('http://localhost:8088/login.html', { waitUntil:'networkidle2' });
  await page.waitForSelector('#email');
  await page.type('#email','Uniadmin'); await page.type('#password','Uniadmin@123');
  await Promise.all([ page.click('#loginBtn').catch(()=>{}), page.waitForNavigation({waitUntil:'networkidle2',timeout:20000}).catch(()=>{}) ]);
  await new Promise(r=>setTimeout(r,2000));
  if(!/dashboard/.test(page.url())) await page.goto('http://localhost:8088/dashboard.html',{waitUntil:'networkidle2'});
  await page.waitForFunction(()=>typeof nav==='function',{timeout:15000}).catch(()=>{});
  dbg.push('--- clicking Leads tab ---');
  await page.evaluate(()=>nav('leads'));
  await new Promise(r=>setTimeout(r,6000));
  const dom = await page.evaluate(()=>({
    rows: document.querySelectorAll('#leads-tbody tr').length,
    countBar: document.getElementById('leads-count-bar')?.innerText||'',
    firstRow: (document.querySelector('#leads-tbody tr')?.innerText||'').replace(/\s+/g,' ').slice(0,90),
  }));
  console.log('DEBUG LOGS:\n'+dbg.join('\n'));
  console.log('\nFINAL DOM:', JSON.stringify(dom,null,2));
  await browser.close();
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
