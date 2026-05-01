const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

// ─── Rink Configuration ────────────────────────────────────────────────────
const RINKS = [
  {
    id: 'snoking',
    name: 'Sno-King Ice Arenas',
    location: 'Kirkland / Renton / Snoqualmie, WA',
    color: '#1a6fc4',
    url: 'https://apps.daysmartrecreation.com/dash/x/#/online/snoking/event-registration?event_types=12&program_types=3',
    slideNav: 7,
    type: 'daysmart',
    partyCalendars: [
      { url: 'http://sportsix.sports-it.com/ical?cid=snoking&facility=3', location: 'Snoqualmie' },
    ],
  },
  {
    id: 'kraken',
    name: 'Kraken Community Iceplex',
    location: 'Seattle, WA',
    color: '#32b5b5',
    url: 'https://apps.daysmartrecreation.com/dash/x/#/online/kraken/event-registration?sport_ids=30',
    // URL date param is ignored by the SPA. Instead, click "Next slide" to
    // advance the carousel day-by-day. Session names encode the day of week.
    slideNav: 7,
    type: 'daysmart',
  },
];

// ─── Day-of-week helpers ───────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const NAME_TO_DOW = [
  [/\bsunday(s)?\b/i,    0],
  [/\bmonday(s)?\b/i,    1],
  [/\btuesday(s)?\b/i,   2],
  [/\bwednesday(s)?\b/i, 3],
  [/\bthursday(s)?\b/i,  4],
  [/\bfriday(s)?\b/i,    5],
  [/\bsaturday(s)?\b/i,  6],
];

// Return the next date (from `base`, inclusive) that falls on `targetDow`.
function nextDate(targetDow, base) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  const diff = (targetDow - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  return d;
}

// Infer the calendar date for a slide's sessions from their names.
// Returns the earliest matching date from today onward.
function inferSlideDate(sessions, fromDate) {
  let earliest = null;
  for (const s of sessions) {
    const name = s.name || '';
    for (const [re, dow] of NAME_TO_DOW) {
      if (re.test(name)) {
        const d = nextDate(dow, fromDate);
        if (!earliest || d < earliest) earliest = d;
        break;
      }
    }
    // "M-F only" → next weekday
    if (/\bm-f\b/i.test(name)) {
      const d = new Date(fromDate);
      d.setHours(0, 0, 0, 0);
      if (d.getDay() === 0) d.setDate(d.getDate() + 1);
      if (d.getDay() === 6) d.setDate(d.getDate() + 2);
      if (!earliest || d < earliest) earliest = d;
    }
  }
  return earliest || new Date(fromDate);
}

// ─── Extract cards from the current page state ────────────────────────────
async function extractCards(page, rinkName) {
  return page.evaluate((rinkName) => {
    const results = [];
    document.querySelectorAll('.card.w-100.mb-3').forEach(card => {
      try {
        const titleEl = card.querySelector('h6.flex-grow-1');
        const title = titleEl ? titleEl.innerText.trim() : '';

        let startTime = null, endTime = null;
        for (const div of card.querySelectorAll('.card-body > div')) {
          const text = div.innerText || '';
          if (/\d{1,2}:\d{2}(am|pm)/i.test(text) && text.length < 60) {
            const times = text.match(/\d{1,2}:\d{2}[ap]m/gi);
            if (times?.length >= 1) { startTime = times[0]; endTime = times[1] || null; }
            break;
          }
        }

        const locationEl = card.querySelector('.fa-map-marker-alt');
        const location = locationEl
          ? locationEl.parentElement.innerText.replace(/\s+/g, ' ').trim()
          : null;

        const priceEl = card.querySelector('dash-product-price');
        const priceText = priceEl ? priceEl.innerText.trim() : null;
        const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;

        const registeredEl = [...card.querySelectorAll('span')]
          .find(el => el.innerText && /registered/i.test(el.innerText));
        let registered = null, capacity = null;
        if (registeredEl) {
          const m = registeredEl.innerText.match(/(\d+)\s*\/\s*(\d+)/);
          if (m) { registered = parseInt(m[1]); capacity = parseInt(m[2]); }
        }

        // Sno-King embeds the date in the title ("May 1 - Public Skate")
        let date = null;
        const dateMatch = title.match(/([A-Za-z]+)\s+(\d+)\s+-/);
        if (dateMatch) date = `${dateMatch[1]} ${dateMatch[2]} 2026`;

        const parseTime = (dateStr, timeStr) => {
          if (!dateStr || !timeStr) return null;
          try { return new Date(`${dateStr} ${timeStr}`).toISOString(); }
          catch { return `${dateStr} ${timeStr}`; }
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
      } catch (err) { console.error('Card parse error:', err.message); }
    });
    return results;
  }, rinkName);
}

// ─── DaySmart Scraper ──────────────────────────────────────────────────────
async function scrapeDaySmart(page, rink) {
  console.log(`\n  Scraping ${rink.name}...`);
  await page.goto(rink.url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(5000);
  try { await page.waitForSelector('.card.w-100.mb-3', { timeout: 10000 }); }
  catch { console.log('  Warning: timed out waiting for cards, trying anyway...'); }

  const sessions = await extractCards(page, rink.name);
  console.log(`  ✓ Found ${sessions.length} sessions`);
  return sessions.map(s => ({ ...s, rinkId: rink.id }));
}

// Read the current slide's date from the swiper carousel active card.
async function readSwiperDate(page) {
  const result = await page.evaluate(() => {
    const active = document.querySelector('.swiper-slide-active');
    if (!active) return null;
    const monthEl = active.querySelector('h6');
    const dayEl = active.querySelector('h3');
    if (!monthEl || !dayEl) return null;
    return { month: monthEl.innerText.trim(), day: parseInt(dayEl.innerText.trim(), 10) };
  });
  if (!result || isNaN(result.day)) return null;
  const monthIdx = MONTHS.findIndex(m => m.toLowerCase() === result.month.toLowerCase().slice(0, 3));
  if (monthIdx === -1) return null;
  const d = new Date(new Date().getFullYear(), monthIdx, result.day);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── DaySmart slide-nav scraper ────────────────────────────────────────────
async function scrapeDaySmartSlideNav(page, rink, numDays) {
  console.log(`\n  Scraping ${rink.name} via slide nav (${numDays} days)...`);
  await page.goto(rink.url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(5000);
  try { await page.waitForSelector('.card.w-100.mb-3', { timeout: 10000 }); }
  catch { console.log('  Warning: no cards found on initial load'); }

  const allSessions = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let slideDate = null;

  for (let i = 0; i < numDays; i++) {
    const raw = await extractCards(page, rink.name);
    console.log(`  Slide ${i}: ${raw.length} cards`);

    if (i === 0) {
      // Prefer reading the date from the swiper carousel; fall back to name inference.
      slideDate = await readSwiperDate(page) || inferSlideDate(raw, today);
      console.log(`  Slide 0 date: ${MONTHS[slideDate.getMonth()]} ${slideDate.getDate()} ${slideDate.getFullYear()}`);
    }

    if (raw.length > 0 && slideDate) {
      const dateLabel = `${MONTHS[slideDate.getMonth()]} ${slideDate.getDate()} ${slideDate.getFullYear()}`;
      for (const s of raw) {
        allSessions.push({
          ...s,
          rinkId: rink.id,
          date: dateLabel,
          start: s.startRaw ? `${dateLabel} ${s.startRaw}` : s.start,
          end:   s.endRaw   ? `${dateLabel} ${s.endRaw}`   : s.end,
        });
      }
    }

    if (i < numDays - 1) {
      try {
        await page.click('button[aria-label="Next slide"]');
        await page.waitForTimeout(2500);
        if (slideDate) slideDate = new Date(slideDate.getTime() + 86400000); // +1 day
      } catch {
        console.log('  No Next slide button — stopping early');
        break;
      }
    }
  }

  console.log(`  ✓ Total ${rink.name} sessions: ${allSessions.length}`);
  return allSessions;
}

// ─── Party rental calendar ────────────────────────────────────────────────

function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchText(next, redirects - 1));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Parse iCal text → array of { date, startMin, endMin, location } for Party Room Rental events.
function parsePartyRentals(ical) {
  const rentals = [];
  const blocks = ical.split('BEGIN:VEVENT');
  for (const block of blocks.slice(1)) {
    const get = key => { const m = block.match(new RegExp(`${key}[^:]*:([^\r\n]+)`)); return m ? m[1].trim() : ''; };
    if (!/party room rental/i.test(get('SUMMARY'))) continue;
    const dtstart = get('DTSTART');
    const dtend   = get('DTEND');
    if (!dtstart || !dtend) continue;
    const toMin = s => parseInt(s.slice(9, 11), 10) * 60 + parseInt(s.slice(11, 13), 10);
    rentals.push({
      date:     dtstart.slice(0, 8),        // "YYYYMMDD"
      startMin: toMin(dtstart),
      endMin:   toMin(dtend),
      location: get('LOCATION'),
    });
  }
  return rentals;
}

// For each session, set partyWarning:true if a rental at the same location
// falls within 1 hour before or after the session window.
async function tagPartyWarnings(sessions, partyCalendars) {
  for (const cal of partyCalendars) {
    let rentals;
    try {
      const text = await fetchText(cal.url);
      rentals = parsePartyRentals(text);
      console.log(`  Party rentals fetched for ${cal.location}: ${rentals.length} found`);
    } catch (err) {
      console.error(`  Warning: could not fetch party calendar for ${cal.location}: ${err.message}`);
      continue;
    }

    for (const s of sessions) {
      if (!s.location || !s.location.includes(cal.location)) continue;
      // Parse "May 2 2026 4:30pm" → YYYYMMDD + minutes
      const startDt = parseSessionDateTime(s.start);
      const endDt   = parseSessionDateTime(s.end);
      if (!startDt || !endDt) continue;
      const sessionDate = `${startDt.getFullYear()}${String(startDt.getMonth()+1).padStart(2,'0')}${String(startDt.getDate()).padStart(2,'0')}`;
      const sessionStartMin = startDt.getHours() * 60 + startDt.getMinutes();
      const sessionEndMin   = endDt.getHours()   * 60 + endDt.getMinutes();

      for (const r of rentals) {
        if (r.date !== sessionDate) continue;
        if (r.startMin < sessionEndMin + 60 && r.endMin > sessionStartMin - 60) {
          s.partyWarning = true;
          break;
        }
      }
    }
  }
}

// Parse "May 2 2026 4:30pm" or ISO strings → Date (local time interpretation).
function parseSessionDateTime(str) {
  if (!str) return null;
  try {
    // Already ISO
    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return new Date(str);
    // "May 2 2026 4:30pm"
    const m = str.match(/([A-Za-z]+)\s+(\d+)\s+(\d{4})\s+(\d{1,2}):(\d{2})(am|pm)/i);
    if (!m) return null;
    const MONTHS_MAP = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const mo = MONTHS_MAP[m[1].toLowerCase().slice(0,3)];
    let hr = parseInt(m[4]);
    if (m[6].toLowerCase() === 'pm' && hr !== 12) hr += 12;
    if (m[6].toLowerCase() === 'am' && hr === 12) hr = 0;
    return new Date(parseInt(m[3]), mo, parseInt(m[2]), hr, parseInt(m[5]));
  } catch { return null; }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('⛸  Starting ice skate time scraper...');

  const browser = await chromium.launch({ headless: true });
  const output = { scrapedAt: new Date().toISOString(), rinks: [] };

  for (const rink of RINKS) {
    const page = await browser.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,mp4,mp3}', r => r.abort());

    const rinkOutput = {
      id: rink.id, name: rink.name, location: rink.location,
      color: rink.color, url: rink.url, sessions: [], error: null,
    };

    try {
      if (rink.slideNav) {
        rinkOutput.sessions = await scrapeDaySmartSlideNav(page, rink, rink.slideNav);
      } else {
        rinkOutput.sessions = await scrapeDaySmart(page, rink);
      }
    } catch (err) {
      rinkOutput.error = err.message;
      console.error(`  ✗ ${rink.name} failed: ${err.message}`);
    }

    if (rink.partyCalendars && rinkOutput.sessions.length > 0) {
      await tagPartyWarnings(rinkOutput.sessions, rink.partyCalendars);
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

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
