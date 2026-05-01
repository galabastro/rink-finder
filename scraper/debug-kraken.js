const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,mp4,mp3}', r => r.abort());

  const today = new Date().toISOString().split('T')[0];
  const url = `https://apps.daysmartrecreation.com/dash/x/#/online/kraken/event-registration?date=${today}&sport_ids=30`;
  console.log('Navigating to:', url);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(6000);

  try {
    await page.waitForSelector('.card.w-100.mb-3', { timeout: 10000 });
    console.log('Cards found!');
  } catch {
    console.log('No .card.w-100.mb-3 found — saving page anyway for inspection');
  }

  // Dump full structure of every card
  const cardData = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card.w-100.mb-3')];
    return cards.map((card, i) => ({
      index: i,
      fullText: card.innerText,
      h6: card.querySelector('h6')?.innerText,
      // All elements with class names and their text
      elements: [...card.querySelectorAll('*')].map(el => ({
        tag: el.tagName,
        classes: el.className,
        text: el.innerText?.trim().slice(0, 200),
      })).filter(e => e.text),
    }));
  });

  console.log(`\nFound ${cardData.length} cards`);
  cardData.forEach(c => {
    console.log(`\n=== Card ${c.index} ===`);
    console.log('h6:', c.h6);
    console.log('Full text:', c.fullText?.replace(/\n/g, ' | '));
    console.log('Elements:');
    c.elements.forEach(e => console.log(`  <${e.tag} class="${e.classes}"> ${e.text}`));
  });

  const html = await page.content();
  const outPath = path.join(__dirname, '..', 'docs', 'debug-kraken.html');
  fs.writeFileSync(outPath, html);
  console.log('\nFull page HTML saved to:', outPath);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
