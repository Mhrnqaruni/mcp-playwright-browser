import assert from 'node:assert/strict';
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <body>
        <button id="open-popup">Open popup</button>
        <button id="open-dialog">Open dialog</button>
        <button id="start-download">Start download</button>
        <script>
          document.getElementById('open-popup').addEventListener('click', () => {
            window.open('about:blank#popup-test', '_blank');
          });

          document.getElementById('open-dialog').addEventListener('click', () => {
            confirm('Confirm test dialog');
          });

          document.getElementById('start-download').addEventListener('click', () => {
            const blob = new Blob(['hello world'], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'hello.txt';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          });
        </script>
      </body>
    </html>
  `);

  const popupPromise = page.waitForEvent('popup');
  await page.click('#open-popup');
  const popup = await popupPromise;
  assert.ok(popup.url().includes('about:blank'));
  await popup.close();

  page.once('dialog', (dlg) => {
    dlg.dismiss().catch(() => {});
  });
  const dialogPromise = page.waitForEvent('dialog');
  await page.click('#open-dialog');
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), 'confirm');
  assert.ok(dialog.message().includes('Confirm test dialog'));
  // dismissed by the auto-dismiss listener above

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#start-download')
  ]);
  const fileName = download.suggestedFilename();
  assert.ok(fileName.length > 0);

  await browser.close();
  console.log('PASS browser-events-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
