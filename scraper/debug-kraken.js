const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function scrapeUrl(page, url) {
  console.log('\nNavigating to:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(8000); // extra wait for Angular filtering

  try { await page.waitForSelector('.card.w-100.mb-3', { timeout: 10000 }); }
  catch { console.log('  No cards found within 10s'); }

  const cards = await page.evaluate(() => {
    return [...document.querySelectorAll('.card.w-100.mb-3')].map((card, i) => ({
      index: i,
      fullText: card.innerText.replace(/\n+/g, ' | '),
      h6: card.querySelector('h6')?.innerText,
    }));
  });

  console.log(`  Found ${cards.length} cards`);
  cards.forEach(c => {
    console.log(`  [${c.index}] h6: ${c.h6}`);
    console.log(`       text: ${c.fullText}`);
  });
  return cards;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,mp4,mp3}', r => r.abort());

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  console.log('Tomorrow:', tomorrowStr);

  // Try different URL variants for Saturday
  const urls = [
    `https://apps.daysmartrecreation.com/dash/x/#/online/kraken/event-registration?date=${tomorrowStr}&&sport_ids=30`,
    `https://apps.daysmartrecreation.com/dash/x/#/online/kraken/event-registration?date=${tomorrowStr}`,
    `https://apps.daysmartrecreation.com/dash/x/#/online/kraken/event-registration?sport_ids=30`,
    `https://apps.daysmartrecreation.com/dash/x/#/online/kraken/event-registration`,
  ];

  for (const url of urls) {
    await scrapeUrl(page, url);
  }

  // Save last page HTML for inspection
  const html = await page.content();
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'debug-kraken.html'), html);
  console.log('\nSaved last page HTML to docs/debug-kraken.html');

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
