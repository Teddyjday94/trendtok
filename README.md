# TrendTok

A personal take on trend-tracking apps like TrendTok. It runs on your own computer or on Vercel.
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

- **My Account** (once you log in with TikTok): followers and weekly change, your typical views and
  engagement, a follower growth chart, a best-times-to-post grid, which video lengths and hashtags work
  for you, every video with views, engagement, views gained this week and hit/low labels, videos that
  are taking off right now, and trending hashtags you haven't used yet. It also gives plain-English
  suggestions built from those numbers.

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

**Your account (My Account tab):** TikTok's official Login Kit and Display API, through "Log in with TikTok".
This is the reliable part of the app.

**Trends (Hashtags, Sounds, Creators, Videos, Lookup):** TikTok Creative Center. In October 2026 TikTok
rebuilt Creative Center and put most of its data behind a TikTok for Business login. Without a login,
the only public data is:

- the **top 3 trending hashtags** per country, for the last 7 or 30 days, with their popularity curves,
  post counts and views (`POST ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList`).

Everything else now answers "InvalidLogin" or "no permission": sounds, creators, videos, 120-day trends,
and details for any single hashtag. Those tabs say so instead of showing made-up numbers, and
**Lookup** can only find hashtags that are currently in the public top 3. Alerts still work against
that list. Results are cached for 30 minutes; press **Refresh** to skip the cache.

This isn't an official API, so TikTok can change it again. The code is in `lib/creative-center.mjs`.
Keep it to personal use and check TikTok's terms of service yourself.

`npm run offline` still runs the whole app on built-in sample data, which is useful for trying out the UI.

## Layout

```
server.mjs                 HTTP server and JSON API (/api/trends, /api/lookup, /api/watchlist, /api/alerts)
lib/creative-center.mjs    fetches pages and extracts the embedded lists
lib/normalize.mjs          maps raw records to one common shape
lib/momentum.mjs           momentum score and status
lib/trends.mjs             live → cache loading (sample data only offline), shared by the API and the collector
lib/hashtag-lookup.mjs     single-hashtag detail pages
lib/alerts.mjs             keyword matching, scheduled collection, alert log
lib/notify.mjs             desktop notifications
lib/app.mjs                the request handler shared by server.mjs and Vercel
lib/auth.mjs               sessions, login, token encryption
lib/tiktok.mjs             TikTok Login Kit + Display API client
lib/account.mjs            connected account: token refresh, sync, daily snapshots
lib/analysis.mjs           the My Account numbers and suggestions
lib/email.mjs              alert and weekly report emails (Resend)
api/main.mjs               Vercel function entry point
vercel.json                Vercel routing and the daily cron job
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

## Run it on Vercel

1. **Import the repo:** in Vercel, go to Add New → Project, pick `trendtok`, and deploy. No build settings are needed.
2. **Add storage:** open the project → Storage → Marketplace → **Upstash** (Redis) → create the database and
   connect it to the project. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you. Without it,
   the app still runs, but anything it saves is lost between restarts.
3. **Set environment variables:** go to Settings → Environment Variables, add the variables below, then redeploy.

| Variable | Needed? | What it is |
|---|---|---|
| `SESSION_SECRET` | **Required** | Any random text, 32+ characters. It signs logins and encrypts your TikTok tokens. |
| `APP_URL` | Recommended | Your production address, e.g. `https://trendtok-yourname.vercel.app` (no trailing slash). |
| `CRON_SECRET` | Recommended | Any random text. Vercel sends it with the daily cron job, so nobody else can trigger it. |
| `APP_PASSWORD` | Optional | Lets you log in with a password, which is handy before TikTok login is set up. |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | For TikTok login | From your TikTok developer app (see below). |
| `TIKTOK_USERNAME` | For TikTok login | Your TikTok handle. **Only this account can log in.** |
| `RESEND_API_KEY` / `ALERT_EMAIL` | For email | A [Resend](https://resend.com) API key and the address to send to. Without your own domain, Resend can only send to the address on your Resend account. |
| `RESEND_FROM` | Optional | Sender, e.g. `TrendTok <alerts@yourdomain.com>` once you've verified a domain in Resend. |
| `REPORT_TIMEZONE` | Optional | Time zone for the weekly email (default `America/Chicago`). |

**How it runs on Vercel:**

- The cron job in `vercel.json` runs once a day at 13:17 UTC, which is about 8am US Central. The Hobby plan
  allows one run a day, at an approximate time within that hour. Each run:
  - checks your alert keywords,
  - syncs your TikTok account and saves the day's snapshot, and
  - once a week, emails the report.
- Alerts are sent by email instead of desktop notifications.
- Creative Center requests from Vercel work (tested October 2026), but see the limits under
  "Where the data comes from".

## Connect your TikTok account

This uses TikTok's official "Log in with TikTok". You approve access on TikTok's own page, and the app gets
read-only access to your profile and public videos. It never sees your password.

1. Go to [developers.tiktok.com](https://developers.tiktok.com/), log in with your TikTok account, and
   create an app under **Manage apps**.
2. Fill in the app details. For the links, use your Vercel address:
   - Terms of service: `https://YOUR-APP.vercel.app/terms.html`
   - Privacy policy: `https://YOUR-APP.vercel.app/privacy.html`
3. Add the **Login Kit** product. For **Web**, set the redirect URI to
   `https://YOUR-APP.vercel.app/api/auth/tiktok/callback`. This must match `APP_URL` exactly.
4. Add these scopes: `user.info.basic`, `user.info.profile`, `user.info.stats` and `video.list`.
5. **Use Sandbox mode** so you don't have to submit the app for review. Create a sandbox and add your own
   TikTok account as a target user. Copy the sandbox's **Client key** and **Client secret** into Vercel as
   `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`, set `TIKTOK_USERNAME`, and redeploy.
6. Open the app and click **Log in with TikTok**.

TikTok changes its developer portal often, so the screens may not match these steps exactly.

**What it can't see:** watch time, retention, traffic sources and follower demographics. The standard TikTok
API doesn't provide them. Business accounts can get some of them through TikTok's separate Business API,
which needs its own approval. That's a possible next step.

**Running locally:** the same variables work with `npm start`. TikTok requires an HTTPS redirect URI, so
local TikTok login needs a tunnel (for example `cloudflared tunnel --url http://localhost:5173`). Set
`APP_URL` to the tunnel address and register that callback too.
