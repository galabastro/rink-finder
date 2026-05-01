# ⛸ Local Ice Times

A static website that aggregates public skate times from local rinks. A Playwright scraper runs automatically via GitHub Actions every 6 hours and commits a `schedule.json` that the HTML page reads.

## Project Structure

```
skate-times/
├── .github/
│   └── workflows/
│       └── scrape.yml       # GitHub Actions: runs scraper on schedule
├── scraper/
│   └── scrape.js            # Playwright scraper
├── docs/                    # Static site (served via GitHub Pages)
│   ├── index.html           # The visualization page
│   └── schedule.json        # Auto-updated by scraper
├── package.json
└── README.md
```

## Setup

### 1. Create a GitHub repo and push this code

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/skate-times.git
git push -u origin main
```

### 2. Enable GitHub Pages

In your repo settings → **Pages** → Source: **Deploy from a branch** → Branch: `main`, folder: `/docs`

Your site will be live at `https://YOUR_USERNAME.github.io/skate-times/`

### 3. Enable GitHub Actions write permissions

In your repo settings → **Actions** → **General** → **Workflow permissions** → select **Read and write permissions**

This lets the scraper commit `schedule.json` back to the repo.

### 4. Run the scraper manually (first time)

Go to **Actions** → **Scrape Skate Times** → **Run workflow**

After it completes, your site will show real data.

---

## Adding More Rinks

Edit `scraper/scrape.js` and add to the `RINKS` array:

```js
{
  id: 'my-rink',           // unique slug
  name: 'My Rink Name',
  location: 'City, WA',
  color: '#e84545',        // color shown in the UI
  url: 'https://...',      // public booking/schedule page
  type: 'daysmart',
  facility: 'my-rink',
},
```

If the rink uses a different booking system, you may need to add a custom scraper function in `scrape.js`.

## Running Locally

```bash
npm install
npx playwright install chromium
npm run scrape
# Open docs/index.html in a browser
```

## Debugging the Scraper

The scraper tries two methods:
1. **API interception** — listens for XHR/fetch calls the page makes and extracts JSON
2. **DOM scraping** — falls back to parsing rendered HTML elements

If neither works for a rink, open that rink's URL in Chrome DevTools → Network → XHR, find the API call, and add a custom handler in `scrape.js`.
