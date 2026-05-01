const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Rink Configuration ────────────────────────────────────────────────────
const RINKS = [
  {
    id: 'snoking-kirkland',
    name: 'Sno-King Kirkland',
    location: 'Kirkland, WA',
    color: '#1a6fc4',
    url: 'https://apps.daysmartrecreation.com/dash/x/#/online/snoking/event-registration?event_types=12&program_types=3',
    type: 'daysmart',
  },
  // Add more rinks here:
  // {
  //   id: 'snoking-renton',
  //   name: 'Sno-King Renton',
  //   location: 'Renton, WA',
  //   color: '#c41a1a',
  //   url: 'https://apps.daysmartrecreation.com/dash/x/#/online/snoking/event-registration?event_types=12&program_types=3&facility=2',
  //   type: 'daysmart',
  // },
];

// ─── DaySmart Scraper ──────────────────────────────────────────────────────
async function scrapeDaySmart(page, rink) {
  console.log(`\n  Scraping ${rink.name}...`);

  // Capture all API JSON responses while the page loads
  const apiData = [];
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (ct.includes('json') && response.status() === 200) {
      try {
        const json = await response.json();
        apiData.push({ url, json });
        console.log(`    [XHR] ${url}`);
      } catch {}
    }
  });

  // Navigate and wait for the page to fully settle
  await page.goto(rink.url, { waitUntil: 'networkidle', timeout: 45000 });

  // Extra wait for Angular/React to finish rendering
  await page.waitForTimeout(5000);

  console.log(`    Captured ${apiData.length} JSON API response(s)`);

  // ── Try API interception first ──
  const sessions = [];
  for (const { url, json } of apiData) {
    const extracted = extractDaySmartEvents(json, rink);
    if (extracted.length > 0) {
      console.log(`    ✓ Extracted ${extracted.length} sessions from: ${url}`);
      sessions.push(...extracted);
    }
  }

  if (sessions.length > 0) return sessions;

  // ── Fallback: parse rendered DOM ──
  console.log('    No sessions from API, scraping rendered DOM...');

  // Dump a snapshot of the page HTML for debugging
  const html = await page.content();
  const debugPath = path.join(__dirname, '..', 'docs', `debug-${rink.id}.html`);
  fs.writeFileSync(debugPath, html);
  console.log(`    [debug] Wrote rendered HTML to ${debugPath}`);

  // Grab all visible text nodes that look like times/events
  const domSessions = await page.evaluate(() => {
    const results = [];

    // DaySmart renders event rows — try a broad set of selectors
    const selectors = [
      '[class*="event"]',
      '[class*="session"]',
      '[class*="program"]',
      '[class*="schedule"]',
      '[class*="activity"]',
      'tr',
      'li',
    ];

    let cards = [];
    for (const sel of selectors) {
      const found = [...document.querySelectorAll(sel)].filter(el => {
        const t = el.innerText || '';
        return /\d{1,2}:\d{2}\s*(am|pm)/i.test(t) && t.length < 500;
      });
      if (found.length > 0) {
        cards = found;
        break;
      }
    }

    for (const card of cards) {
      const text = (card.innerText || '').trim();
      const timeMatches = text.match(/\d{1,2}:\d{2}\s*(AM|PM)/gi) || [];
      const dateMatch = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*\d{4}/i)
        || text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);

      results.push({
        text,
        times: timeMatches,
        date: dateMatch ? dateMatch[0] : null,
      });
    }

    return results;
  });

  console.log(`    Found ${domSessions.length} DOM element(s) with times`);

  for (const item of domSessions) {
    const [startTime, endTime] = item.times;
    sessions.push({
      rinkId: rink.id,
      name: 'Public Skate',
      start: [item.date, startTime].filter(Boolean).join(' '),
      end: endTime ? [item.date, endTime].filter(Boolean).join(' ') : null,
      location: rink.name,
      price: null,
      spotsRemaining: null,
      raw: { text: item.text },
    });
  }

  return sessions;
}

// ─── Parse DaySmart API response shapes ────────────────────────────────────
function extractDaySmartEvents(json, rink) {
  const sessions = [];

  const candidates = [
    json?.data,
    json?.events,
    json?.sessions,
    json?.results,
    json?.items,
    Array.isArray(json) ? json : null,
  ].filter(Array.isArray);

  for (const list of candidates) {
    for (const item of list) {
      const session = parseDaySmartItem(item, rink);
      if (session) sessions.push(session);
    }
    if (sessions.length > 0) break;
  }

  return sessions;
}

function parseDaySmartItem(item, rink) {
  if (typeof item !== 'object' || !item) return null;

  const name = item.name || item.title || item.event_name || item.program_name || '';
  const start = item.start_date || item.start || item.date_start || item.begins || item.startTime || '';
  const end = item.end_date || item.end || item.date_end || item.ends || item.endTime || '';
  const location = item.facility_name || item.location || item.rink || '';
  const price = item.price ?? item.cost ?? item.amount ?? null;
  const spots = item.spots_remaining ?? item.available_spots ?? item.openSpots ?? null;

  if (!start) return null;

  return {
    rinkId: rink.id,
    name: name || 'Public Skate',
    start,
    end: end || null,
    location: location || rink.name,
    price: price !== null ? parseFloat(price) : null,
    spotsRemaining: spots !== null ? parseInt(spots) : null,
  };
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

    // Block images/fonts/media to speed things up
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,mp3}', r => r.abort());

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
      const sessions = await scrapeDaySmart(page, rink);
      rinkOutput.sessions = sessions;
      console.log(`\n  ✓ ${rink.name}: ${sessions.length} session(s)\n`);
    } catch (err) {
      rinkOutput.error = err.message;
      console.error(`\n  ✗ ${rink.name} failed: ${err.message}\n`);
    }

    output.rinks.push(rinkOutput);
    await page.close();
  }

  await browser.close();

  const outPath = path.join(__dirname, '..', 'docs', 'schedule.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n✅ Done`);
  console.log(`   Wrote: ${outPath}`);
  console.log(`   Total sessions: ${output.rinks.reduce((n, r) => n + r.sessions.length, 0)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});