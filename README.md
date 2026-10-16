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
- **Hashtag lookup** (Lookup tab): look up any hashtag, including ones that aren't on the top chart,
  like #pressurewashing. It shows chart rank, momentum, posts and views for the period and all time,
  the popularity curve, audience age and countries, and related hashtags (click one to look it up). Every
  lookup saves the numbers, so a views-over-time chart of your own builds up.
- **Niche alerts and daily collection** (Alerts tab): add keywords like "pressure washing" or "cleantok".
  While the server runs, it pulls every chart for up to 3 countries on a schedule (every 24 hours by default,
  plus a check shortly after start if one is due). That builds your rank history even if you never open the
  page. You get an alert when something matching a keyword:
  - appears on a hashtag, sound, creator or video chart (or comes back after dropping off), or
  - turns Breakout, either on a chart or in its own hashtag lookup.

  Alerts appear in the tab with an unread count, and rows that match a keyword are marked in the trend
  lists. A desktop notification is also sent through your operating system (macOS notification centre,
  Windows balloon, or `notify-send` on Linux), so it works with the browser closed. You can also allow
  browser notifications for when the page is open.

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
server.mjs                 HTTP server and JSON API (/api/trends, /api/lookup, /api/watchlist, /api/alerts)
lib/creative-center.mjs    fetches pages and extracts the embedded lists
lib/normalize.mjs          maps raw records to one common shape
lib/momentum.mjs           momentum score and status
lib/trends.mjs             live → cache → sample loading, shared by the API and the collector
lib/hashtag-lookup.mjs     single-hashtag detail pages
lib/alerts.mjs             keyword matching, scheduled collection, alert log
lib/notify.mjs             desktop notifications
lib/sample-data.mjs        offline sample data
lib/store.mjs              JSON files in data/ (cache, history, series, watchlist, alerts)
public/                    the UI (plain HTML, CSS and JS)
test/                      node:test suite
```

The server only listens on 127.0.0.1. Set `HOST=0.0.0.0` if you want to open it from your
phone on the same Wi-Fi network.

## Keep it collecting

Alerts and daily collection only run while `npm start` is running. To have it start at login:

- **macOS**: create an Automator "Application" that runs `cd /path/to/trendtok && /usr/local/bin/node server.mjs`, then
  add it under System Settings → General → Login Items.
- **Windows**: create a shortcut to `cmd /c "cd /d C:\path\to\trendtok && node server.mjs"` in
  `shell:startup` (press Win+R, then type `shell:startup`).
- **Linux**: add a systemd user service or an `@reboot` crontab entry.
