const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Rink Configuration ────────────────────────────────────────────────────
const RINKS = [
  {
    id: 'snoking',
    name: 'Sno-King Ice Arenas',
    location: 'Kirkland / Renton / Snoqualmie, WA',
    color: '#1a6fc4',
    url: 'https://apps.daysmartrecreation.com/dash/x/#/online/snoking/event-registration?event_types=12&program_types=3',
    type: 'daysmart',
  },
  {
    id: 'kraken',
    name: 'Kraken Community Iceplex',
    location: 'Seattle, WA',
    color: '#32b5b5',
    url: 'https://apps.daysmartrecreation.com/dash/x/#/online/kraken/event-registration?sport_ids=30',
    type: 'daysmart',
  },
];

// ─── DaySmart Scraper ──────────────────────────────────────────────────────
async function scrapeDaySmart(page, rink) {
  console.log(`\n  Scraping ${rink.name}...`);

  await page.goto(rink.url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(5000);

  // Wait for event cards to appear
  try {
    await page.waitForSelector('.card.w-100.mb-3', { timeout: 10000 });
  } catch (e) {
    console.log('  Warning: timed out waiting for cards, trying anyway...');
  }

  const sessions = await page.evaluate((rinkName) => {
    const results = [];

    // Each event is a card with class "card w-100 mx-0 mb-3"
    const cards = document.querySelectorAll('.card.w-100.mb-3');
    console.log(`Found ${cards.length} cards`);

    cards.forEach(card => {
      try {
        // Title: h6 containing "May 1 - Public Skate" etc
        const titleEl = card.querySelector('h6.flex-grow-1');
        const title = titleEl ? titleEl.innerText.trim() : '';

        // Time: first div inside card-body that has "am" or "pm"
        // It's the div directly containing "9:30am - 11:00am"
        let startTime = null, endTime = null;
        const allDivs = card.querySelectorAll('.card-body > div');
        for (const div of allDivs) {
          const text = div.innerText || '';
          if (/\d{1,2}:\d{2}(am|pm)/i.test(text) && text.length < 60) {
            // Extract start and end times
            const times = text.match(/\d{1,2}:\d{2}[ap]m/gi);
            if (times && times.length >= 1) {
              startTime = times[0];
              endTime = times[1] || null;
            }
            break;
          }
        }

        // Location: div containing fa-map-marker-alt
        const locationEl = card.querySelector('.fa-map-marker-alt');
        const location = locationEl
          ? locationEl.parentElement.innerText.replace(/\s+/g, ' ').trim()
          : null;

        // Price: dash-product-price
        const priceEl = card.querySelector('dash-product-price');
        const priceText = priceEl ? priceEl.innerText.trim() : null;
        const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;

        // Registered count: "7/400 Registered"
        const registeredEl = [...card.querySelectorAll('span')].find(
          el => el.innerText && /registered/i.test(el.innerText)
        );
        let registered = null, capacity = null;
        if (registeredEl) {
          const match = registeredEl.innerText.match(/(\d+)\s*\/\s*(\d+)/);
          if (match) {
            registered = parseInt(match[1]);
            capacity = parseInt(match[2]);
          }
        }

        // Parse date from title (e.g. "May 1 - Public Skate")
        let date = null;
        const dateMatch = title.match(/([A-Za-z]+)\s+(\d+)/);
        if (dateMatch) {
          date = `${dateMatch[1]} ${dateMatch[2]} 2026`; // assumes current year
        }

        // Build ISO-like start/end strings
        const parseTime = (dateStr, timeStr) => {
          if (!dateStr || !timeStr) return null;
          try {
            return new Date(`${dateStr} ${timeStr}`).toISOString();
          } catch {
            return `${dateStr} ${timeStr}`;
          }
        };

        if (title && startTime) {
          results.push({
            name: title.replace(/^[A-Za-z]+ \d+\s*-\s*/, '').trim() || title,
            date,
            start: parseTime(date, startTime),
            end: parseTime(date, endTime),
            startRaw: startTime,
            endRaw: endTime,
            location: location ? location.replace(rinkName + ' - ', '').trim() : null,
            price: isNaN(price) ? null : price,
            registered,
            capacity,
            spotsRemaining: (capacity && registered !== null) ? capacity - registered : null,
          });
        }
      } catch (err) {
        console.error('Error parsing card:', err.message);
      }
    });

    return results;
  }, rink.name);

  console.log(`  ✓ Found ${sessions.length} sessions`);
  if (sessions.length > 0) {
    console.log(`    Sample: ${sessions[0].name} @ ${sessions[0].startRaw} — ${sessions[0].location}`);
  }

  return sessions.map(s => ({ ...s, rinkId: rink.id }));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('⛸  Starting ice skate time scraper...');

  const browser = await chromium.launch({ headless: true });
  const output = {
    scrapedAt: new Date().toISOString(),
    rinks: [],
  };

  for (const rink of RINKS) {
    const page = await browser.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,mp4,mp3}', r => r.abort());

    const rinkOutput = {
      id: rink.id,
      name: rink.name,
      location: rink.location,
      color: rink.color,
      url: rink.url,
      sessions: [],
      error: null,
    };

    try {
      rinkOutput.sessions = await scrapeDaySmart(page, rink);
    } catch (err) {
      rinkOutput.error = err.message;
      console.error(`  ✗ ${rink.name} failed: ${err.message}`);
    }

    output.rinks.push(rinkOutput);
    await page.close();
  }

  await browser.close();

  const outPath = path.join(__dirname, '..', 'docs', 'schedule.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n✅ Done — ${output.rinks.reduce((n, r) => n + r.sessions.length, 0)} total sessions`);
  console.log(`   Wrote: ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});