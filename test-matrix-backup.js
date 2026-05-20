const { chromium } = require('playwright');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

(async () => {

  const browser = await chromium.launch({
    headless: false,
    args: ['--ignore-certificate-errors']
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true
  });

  const page = await context.newPage();

  // Open Matrix UCS
  await page.goto(
    'https://192.168.0.81:1026',
    {
      waitUntil: 'domcontentloaded',
      timeout: 0
    }
  );

  console.log('\nLOGIN MANUALLY');
  console.log('OPEN MANUAL BACKUP PAGE');
  console.log('CLICK BACKUP YOURSELF');
  console.log('\nWHEN BACKUP STARTS TYPE: ok\n');

  rl.question(
    'Type ok to start monitoring: ',
    async (answer) => {

      if (answer.toLowerCase() !== 'ok') {

        console.log('Cancelled');

        await browser.close();

        process.exit(0);
      }

      console.log('\nMonitoring backup progress...\n');

      while (true) {

        try {

          console.clear();

          console.log('==============================');
          console.log(' MATRIX UCS BACKUP MONITOR');
          console.log('==============================\n');

          console.log('MAIN PAGE URL:');
          console.log(page.url());

          const frames = page.frames();

          console.log('\nTOTAL FRAMES:', frames.length);

          let found = false;

          for (const frame of frames) {

            try {

              console.log('\n--------------------------------');
              console.log('FRAME URL:');
              console.log(frame.url());

              const html = await frame.content();

              console.log('HTML captured');

              // Detect backup status block
              if (
                html.includes('Backup Status') ||
                html.includes('Files:') ||
                html.includes('Completed:')
              ) {

                found = true;

                console.log('\n✅ BACKUP FRAME FOUND\n');

                // Extract readable backup section
                let startIndex =
                  html.indexOf('Backup Status');

                if (startIndex < 0) {
                  startIndex = 0;
                }

                let endIndex =
                  html.indexOf('Abort');

                if (endIndex < 0) {
                  endIndex = startIndex + 3000;
                }

                const snippet =
                  html.substring(
                    startIndex,
                    endIndex
                  );

                console.log(snippet);

                // Extract percentage
                const percentMatch =
                  html.match(/Completed:\s*(\d+)%/i);

                if (percentMatch) {

                  console.log(
                    '\n📊 Progress:',
                    percentMatch[1] + '%'
                  );

                  // Auto detect completion
                  if (
                    percentMatch[1] === '100'
                  ) {

                    console.log(
                      '\n✅ BACKUP COMPLETED'
                    );

                    process.exit(0);
                  }
                }

                // Extract files progress
                const filesMatch =
                  html.match(/Files:\s*(\d+\/\d+)/i);

                if (filesMatch) {

                  console.log(
                    '📁 Files:',
                    filesMatch[1]
                  );
                }

                // Extract size progress
                const sizeMatch =
                  html.match(/Size:\s*([^<]+)/i);

                if (sizeMatch) {

                  console.log(
                    '💾 Size:',
                    sizeMatch[1]
                  );
                }
              }

            } catch (frameErr) {

              console.log(
                '\nFrame read error:',
                frameErr.message
              );
            }
          }

          if (!found) {

            console.log(
              '\n❌ Backup info not found yet...'
            );
          }

        } catch (err) {

          console.log(
            '\nMonitor error:',
            err.message
          );
        }

        await page.waitForTimeout(3000);
      }
    }
  );

})();