# TrendTok Local

A personal, run-on-your-own-machine take on trend-tracking apps like TrendTok.
It shows what's trending on TikTok (hashtags, sounds, creators and videos) by
country and time period, and scores each trend's momentum to flag the ones that
are about to take off. You can keep a watchlist with notes.

No accounts, no API keys and no dependencies. You only need Node.js 18.17 or newer.

## Run it

```bash
npm start          # http://127.0.0.1:5173
npm run offline    # sample data only, no network
npm test
```

Change the port with `PORT=8080 npm start`.

## Features

- **Hashtags, Sounds, Creators and Videos** tabs, filterable by country (39) and by period (7, 30 or 120 days).
- **Momentum score (0–100)** with a Breakout, Rising, Steady or Cooling label. The score uses
  the growth of the popularity curve, its recent acceleration, rank movement and whether the
  trend is a new entry. This is the app's own estimate, not a TikTok number.
- **Niche filter** on hashtags (Food, Beauty, Home Improvement and so on), plus search,
  sorting and a "Rising only" toggle.
- **Detail panel** with a popularity chart and a link that opens the trend on TikTok.
- **Your rank history**: each live load (at most once an hour) records the ranks, so over time you
  get your own chart of how a trend has moved.
- **Watchlist** with notes, saved to `data/watchlist.json`.

## Where the data comes from

The server loads TikTok Creative Center's public "Popular" pages
(`ads.tiktok.com/business/creativecenter/...`) from your machine and reads the
trend list that's embedded in each page. Results are cached for 30 minutes in `data/cache.json`.
Press **Refresh** to skip the cache.

This isn't an official API, so:

- If TikTok changes the page layout or blocks the request, the app shows a yellow
  banner and falls back to **sample data**, so it keeps working. The badge in the
  header always tells you whether you're looking at **Live** or **Sample** data.
- The parser doesn't depend on a fixed JSON path. It searches the page data for the list,
  which gives it a better chance of surviving small layout changes. If it does break, the
  logic is in `lib/creative-center.mjs`.
- Each page only embeds its first batch of results (roughly the top 20–50).
- Keep it to personal use and modest refresh rates. Check TikTok's terms of service yourself.

## Layout

```
server.mjs                 HTTP server and JSON API (/api/trends, /api/watchlist)
lib/creative-center.mjs    fetches pages and extracts the embedded lists
lib/normalize.mjs          maps raw records to one common shape
lib/momentum.mjs           momentum score and status
lib/sample-data.mjs        offline sample data
lib/store.mjs              JSON files in data/ (cache, history, watchlist)
public/                    the UI (plain HTML, CSS and JS)
test/                      node:test suite
```

The server only listens on 127.0.0.1. Set `HOST=0.0.0.0` if you want to open it from your
phone on the same Wi-Fi network.
