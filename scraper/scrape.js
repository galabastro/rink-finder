const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Rink Configuration ────────────────────────────────────────────────────
// Add more rinks here as needed. Each rink needs:
//   id:       unique slug used in output JSON
//   name:     display name
//   location: city/neighborhood
//   url:      DaySmart (or other) public skate page
const RINKS = [
  {
    id: 'snoking-kirkland',
    name: 'Sno-King Kirkland',
    location: 'Kirkland, WA',
    color: '#1a6fc4',
    url: 'https://apps.daysmartrecreation.com/dash/x/#/online/snoking/event-registration?event_types=12&program_types=3',
    type: 'daysmart',
    facility: 'snoking',
  },
  // Example: add more rinks like this:
  // {
  //   id: 'snoking-renton',
  //   name: 'Sno-King Renton',
  //   location: 'Renton, WA',
  //   color: '#c41a1a',
  //   url: 'https://apps.daysmartrecreation.com/dash/x/#/online/snoking-renton/event-registration?event_types=12&program_types=3',
  //   type: 'daysmart',
  //   facility: 'snoking-renton',
  // },
];

// ─── DaySmart Scraper ──────────────────────────────────────────────────────
async function scrapeDaySmart(page, rink) {
  console.log(`  Scraping ${rink.name}...`);

  const sessions = [];
  const errors = [];

  // Intercept API responses from DaySmart's backend
  const apiData = [];
  page.on('response', async (response) => {
    const url = response.url();
    // DaySmart fetches event data from these endpoints
    if (url.includes('/api/') && url.includes('event') && response.status() === 200) {
      try {
        const json = await response.json();
        apiData.push({ url, json });
      } catch (e) {
        // Not JSON, skip
      }
    }
  });

  // Load the page and wait for network to settle
  await page.goto(rink.url, { waitUntil: 'networkidle', timeout: 30000 });

  // Give extra time for late XHR calls
  await page.waitForTimeout(3000);

  // Try to extract from intercepted API responses first
  if (apiData.length > 0) {
    console.log(`    Found ${apiData.length} API response(s)`);
    for (const { url, json } of apiData) {
      console.log(`    API URL: ${url}`);
      const extracted = extractDaySmartEvents(json, rink);
      sessions.push(...extracted);
    }
  }

  // Fallback: scrape DOM if no API data was captured
  if (sessions.length === 0) {
    console.log('    No API data captured, attempting DOM scrape...');
    const domSessions = await scrapeDaySmartDOM(page, rink);
    sessions.push(...domSessions);
  }

  return { sessions, errors };
}

// Parse DaySmart API JSON response shapes
function extractDaySmartEvents(json, rink) {
  const sessions = [];

  // DaySmart returns data in various shapes — try common ones
  const candidates = [
    json?.data,
    json?.events,
    json?.sessions,
    json?.results,
    Array.isArray(json) ? json : null,
  ].filter(Boolean);

  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const session = parseDaySmartItem(item, rink);
      if (session) sessions.push(session);
    }
    if (sessions.length > 0) break;
  }

  return sessions;
}

function parseDaySmartItem(item, rink) {
  // Try to extract common fields from DaySmart event objects
  const name = item.name || item.title || item.event_name || item.program_name || '';
  const start = item.start_date || item.start || item.date_start || item.begins || '';
  const end = item.end_date || item.end || item.date_end || item.ends || '';
  const location = item.facility_name || item.location || item.rink || '';
  const price = item.price || item.cost || item.amount || null;
  const spots = item.spots_remaining ?? item.available_spots ?? null;

  if (!name || !start) return null;

  return {
    rinkId: rink.id,
    name,
    start,
    end,
    location: location || rink.name,
    price: price !== null ? parseFloat(price) : null,
    spotsRemaining: spots !== null ? parseInt(spots) : null,
    raw: item,
  };
}

// DOM fallback scraper for DaySmart pages
async function scrapeDaySmartDOM(page, rink) {
  const sessions = [];

  try {
    // Wait for event cards to appear
    await page.waitForSelector('[class*="event"], [class*="session"], [class*="program"]', {
      timeout: 10000,
    });

    const items = await page.evaluate(() => {
      const results = [];
      // Generic selectors that tend to match DaySmart event cards
      const cards = document.querySelectorAll(
        '[class*="event-card"], [class*="session-card"], [class*="program-item"], .event-row, .session-row'
      );

      cards.forEach((card) => {
        const text = card.innerText || '';
        const timeMatch = text.match(/\d{1,2}:\d{2}\s*(AM|PM)/gi);
        const dateMatch = text.match(/\w+ \d{1,2},?\s*\d{4}/gi);

        results.push({
          text: text.trim(),
          time: timeMatch ? timeMatch[0] : null,
          date: dateMatch ? dateMatch[0] : null,
          html: card.innerHTML.substring(0, 500),
        });
      });

      return results;
    });

    console.log(`    Found ${items.length} DOM element(s)`);

    for (const item of items) {
      if (item.time || item.date) {
        sessions.push({
          rinkId: rink.id,
          name: 'Public Skate',
          start: `${item.date || ''} ${item.time || ''}`.trim(),
          end: null,
          location: rink.name,
          price: null,
          spotsRemaining: null,
          raw: { text: item.text },
        });
      }
    }
  } catch (e) {
    console.log(`    DOM scrape failed: ${e.message}`);
  }

  return sessions;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🛹 Starting ice skate time scraper...\n');

  const browser = await chromium.launch({ headless: true });
  const output = {
    scrapedAt: new Date().toISOString(),
    rinks: [],
  };

  for (const rink of RINKS) {
    const page = await browser.newPage();

    // Block images/fonts to speed up scraping
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', (route) =>
      route.abort()
    );

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
      const { sessions, errors } = await scrapeDaySmart(page, rink);
      rinkOutput.sessions = sessions;
      console.log(`  ✓ ${rink.name}: ${sessions.length} session(s) found\n`);
    } catch (err) {
      rinkOutput.error = err.message;
      console.error(`  ✗ ${rink.name}: ${err.message}\n`);
    }

    output.rinks.push(rinkOutput);
    await page.close();
  }

  await browser.close();

  // Write output
  const outPath = path.join(__dirname, '..', 'docs', 'schedule.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);
  console.log(`   Rinks: ${output.rinks.length}`);
  console.log(`   Total sessions: ${output.rinks.reduce((n, r) => n + r.sessions.length, 0)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
