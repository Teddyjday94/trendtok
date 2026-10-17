// The whole API as one request handler, so the same code runs as a local
// Node server (server.mjs) and as a single Vercel function (api/main.mjs).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, backendFromEnv } from './store.mjs';
import { createTrendService } from './trends.mjs';
import { createAlerts } from './alerts.mjs';
import { cleanHashtag } from './hashtag-lookup.mjs';
import { desktopNotify } from './notify.mjs';
import { KINDS } from './normalize.mjs';
import { createAuth } from './auth.mjs';
import { createTikTok } from './tiktok.mjs';
import { createAccount } from './account.mjs';
import { analyze } from './analysis.mjs';
import { createEmail, alertEmail, weeklyReport } from './email.mjs';
import { createTikTokAds } from './tiktok-ads.mjs';
import { createSearchTrends, RISING_PCT } from './search-trends.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PERIODS = [7, 30, 120];
const HOUR = 3600_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  res.end();
}

async function readBody(req, limit = 16 * 1024) {
  // On Vercel the platform may already have parsed the body.
  if ('body' in req) {
    let b;
    try {
      b = req.body;
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    if (b == null || b === '') return {};
    if (Buffer.isBuffer(b) || typeof b === 'string') {
      try {
        return JSON.parse(b.toString() || '{}');
      } catch {
        throw new HttpError(400, 'Invalid JSON');
      }
    }
    return b;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const clip = (v, max = 300) => (v == null ? null : String(v).slice(0, max));
const countryParam = (q) => (/^[A-Z]{2}$/.test(q.get('country') ?? '') ? q.get('country') : 'US');
const periodParam = (q) => (PERIODS.includes(Number(q.get('period'))) ? Number(q.get('period')) : 7);
const cleanUser = (u) => String(u ?? '').trim().replace(/^@/, '').toLowerCase();

export function createHandler({
  env = process.env,
  dataDir = path.join(ROOT, 'data'),
  offline = env.TRENDTOK_OFFLINE === '1',
  fetchImpl,
  notify: desktop = desktopNotify,
  delayMs,
} = {}) {
  const cloud = Boolean(env.VERCEL) || env.AUTH_REQUIRED === '1';
  const store = createStore(backendFromEnv(env, { dataDir, fetchImpl }));
  const trends = createTrendService({ store, offline, fetchImpl });
  const email = createEmail({ apiKey: env.RESEND_API_KEY, to: env.ALERT_EMAIL, from: env.RESEND_FROM || undefined, fetchImpl });
  const tiktok =
    env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET
      ? createTikTok({ clientKey: env.TIKTOK_CLIENT_KEY, clientSecret: env.TIKTOK_CLIENT_SECRET, fetchImpl })
      : null;
  const ads = createTikTokAds({ appId: env.TIKTOK_ADS_APP_ID, secret: env.TIKTOK_ADS_SECRET, fetchImpl });
  const owner = cleanUser(env.TIKTOK_USERNAME);
  const appUrlFromEnv = env.APP_URL?.replace(/\/+$/, '');

  // Alerts notify on the desktop locally and by email when it's configured.
  async function notify(title, message, events) {
    if (!cloud) desktop(title, message, events);
    if (email) await email.send(alertEmail(events, appUrlFromEnv));
  }
  const alerts = createAlerts({ store, trends, notify, offline, delayMs: delayMs ?? (cloud ? 1000 : 2000) });

  // Things that need the session secret are set up on first use, because
  // locally the secret is generated once and kept in the data store.
  let setup;
  function init() {
    setup ??= (async () => {
      let secret = env.SESSION_SECRET;
      if (!secret && cloud) {
        return { error: 'SESSION_SECRET is not set. Add it in Vercel → Settings → Environment Variables (any random text of 32+ characters), then redeploy.' };
      }
      if (!secret) {
        secret = (await store.read('local-secret.json', null))?.secret;
        if (!secret) {
          secret = randomBytes(32).toString('hex');
          await store.write('local-secret.json', { secret });
        }
      }
      if (cloud && !tiktok && !env.APP_PASSWORD) {
        return { error: 'No way to log in is set up. Add APP_PASSWORD, or TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_USERNAME, in Vercel → Settings → Environment Variables.' };
      }
      const auth = createAuth({ secret, secure: cloud });
      const account = tiktok ? createAccount({ store, tiktok, auth }) : null;
      const search = createSearchTrends({ store, ads, auth, env });
      return { auth, account, search };
    })();
    return setup;
  }

  const appUrl = (req) => {
    if (appUrlFromEnv) return appUrlFromEnv;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (cloud ? 'https' : 'http');
    return `${proto}://${host}`;
  };
  const redirectUri = (req) => `${appUrl(req)}/api/auth/tiktok/callback`;

  async function accountPayload(account, { timeZone, autoSync = false } = {}) {
    if (!account) return { connected: false, configured: false };
    let data = await account.data();
    if (!data) return { connected: false, configured: true };
    let syncError = null;
    if (autoSync && !data.profile.needsReconnect && (!data.syncedAt || Date.now() - data.syncedAt > 6 * HOUR)) {
      try {
        await account.sync();
        data = await account.data();
      } catch (err) {
        syncError = err.message;
      }
    }
    const settings = await alerts.getSettings();
    const chart = await trends
      .getTrends({ kind: 'hashtags', country: settings.countries[0] ?? 'US', period: 7 })
      .catch(() => null);
    const analysis = analyze({
      videos: data.videos,
      snapshots: data.snapshots,
      timeZone,
      trending: chart && chart.source !== 'sample' ? chart.items : [],
    });
    return {
      connected: true,
      configured: true,
      profile: data.profile,
      syncedAt: data.syncedAt,
      syncError: syncError ?? data.profile.lastError ?? null,
      trendingSource: chart?.source ?? null,
      analysis,
    };
  }

  // Saves today's TikTok search counts and alerts on keywords that jumped this week.
  // Each keyword alerts at most once every 14 days.
  async function refreshSearchTrends(search) {
    const result = await search.refresh();
    const now = Date.now();
    const fresh = await store.update('search-alert-state.json', {}, (state) => {
      const picked = result.rising.filter((r) => !state[r.keyword] || now - state[r.keyword] > 14 * 24 * HOUR);
      for (const r of picked) state[r.keyword] = now;
      return picked;
    });
    if (fresh.length) {
      await alerts.record(
        fresh.map((r) => ({
          keyword: r.keyword,
          kind: 'search',
          country: 'US',
          name: `"${r.keyword}"`,
          reason: `searches are up ${r.change7d}% this week (${r.searches.toLocaleString('en-US')} a month on TikTok)`,
          url: `https://www.tiktok.com/search?q=${encodeURIComponent(r.keyword)}`,
          momentum: null,
        })),
      );
    }
    return { at: result.at, keywords: result.keywords, rising: result.rising.length, alerted: fresh.length };
  }

  // Daily work: alert check, account sync, search trends, and the weekly report email.
  async function runDaily({ force = false } = {}) {
    const { account, search } = await init();
    const out = {};
    try {
      out.alerts = force ? await alerts.run() : await alerts.runIfDue();
    } catch (err) {
      out.alerts = { error: err.message };
    }
    const acct = account && (await account.getAccount());
    if (acct && !acct.needsReconnect && (force || !acct.lastSync || Date.now() - acct.lastSync > 20 * HOUR)) {
      try {
        out.sync = await account.sync();
      } catch (err) {
        out.sync = { error: err.message };
      }
    }
    if (search && (await search.isConnected())) {
      const last = (await search.data()).fetchedAt;
      if (force || !last || Date.now() - last > 20 * HOUR) {
        try {
          out.search = await refreshSearchTrends(search);
        } catch (err) {
          out.search = { error: err.message };
        }
      }
    }
    if (email && acct) {
      const meta = await store.read('report.json', {});
      if (!meta.lastSent || Date.now() - meta.lastSent > 6.5 * 24 * HOUR) {
        try {
          const data = await account.data();
          const since = Date.now() - 7 * 24 * HOUR;
          const events = (await alerts.getEvents()).filter((e) => e.at >= since);
          const settings = await alerts.getSettings();
          const chart = await trends.getTrends({ kind: 'hashtags', country: settings.countries[0] ?? 'US', period: 7 }).catch(() => null);
          const analysis = analyze({
            videos: data.videos,
            snapshots: data.snapshots,
            timeZone: env.REPORT_TIMEZONE || 'America/Chicago',
            trending: chart && chart.source !== 'sample' ? chart.items : [],
          });
          await email.send(weeklyReport({ profile: data.profile, analysis, events, appUrl: appUrlFromEnv }));
          await store.write('report.json', { lastSent: Date.now() });
          out.report = 'sent';
        } catch (err) {
          out.report = { error: err.message };
        }
      }
    }
    await store.write('cron.json', { lastRun: Date.now(), result: out });
    return out;
  }

  async function alertsPayload() {
    const [settings, events] = await Promise.all([alerts.getSettings(), alerts.getEvents()]);
    return {
      settings,
      events,
      unread: events.filter((e) => !e.read).length,
      running: alerts.isRunning(),
      offline,
      cloud,
      email: email ? email.to : null,
    };
  }

  const PUBLIC_ROUTES = new Set([
    'GET /api/me',
    'GET /api/auth/tiktok',
    'GET /api/auth/tiktok/callback',
    'POST /api/auth/password',
    'POST /api/auth/logout',
    'GET /api/cron',
    'POST /api/cron',
  ]);

  async function handleApi(req, res, url, pathname) {
    const q = url.searchParams;
    const route = `${req.method} ${pathname}`;
    const ctx = await init();

    if (route === 'GET /api/me') {
      const session = ctx.auth?.readSession(req) ?? null;
      const loggedIn = !cloud || Boolean(session);
      const acct = loggedIn && ctx.account ? await ctx.account.getAccount() : null;
      return send(res, 200, {
        cloud,
        loggedIn,
        setupError: ctx.error ?? null,
        login: { tiktok: Boolean(tiktok), password: Boolean(env.APP_PASSWORD) },
        tiktokConfigured: Boolean(tiktok),
        storage: store.kind,
        email: email ? email.to : null,
        offline,
        account: acct ? { displayName: acct.displayName, username: acct.username, avatarUrl: acct.avatarUrl } : null,
      });
    }
    if (ctx.error) throw new HttpError(503, ctx.error);
    const { auth, account } = ctx;

    if (route === 'GET /api/cron' || route === 'POST /api/cron') {
      // Vercel sends "Authorization: Bearer $CRON_SECRET" when CRON_SECRET is set.
      const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
      if (cloud && (!expected || req.headers.authorization !== expected)) throw new HttpError(401, 'Unauthorized');
      return send(res, 200, await runDaily({ force: true }));
    }

    if (route === 'POST /api/auth/password') {
      const b = await readBody(req);
      if (!env.APP_PASSWORD) throw new HttpError(400, 'Password login is not set up');
      if (!auth.checkPassword(b.password ?? '', env.APP_PASSWORD)) {
        await new Promise((r) => setTimeout(r, 500)); // slow down guessing
        throw new HttpError(401, 'Wrong password');
      }
      return send(res, 200, { ok: true }, undefined, { 'set-cookie': auth.issueSession({ sub: 'owner', via: 'password' }) });
    }
    if (route === 'POST /api/auth/logout') {
      return send(res, 200, { ok: true }, undefined, { 'set-cookie': auth.clearSession() });
    }

    if (route === 'GET /api/auth/tiktok') {
      if (!tiktok) return redirect(res, `/?auth_error=${encodeURIComponent('TikTok login is not set up yet (TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET).')}`);
      if (cloud && !owner) {
        return redirect(res, `/?auth_error=${encodeURIComponent('Set TIKTOK_USERNAME to your TikTok handle in Vercel first, so only your account can log in.')}`);
      }
      // Connecting from inside the app (already logged in by password) is fine too.
      const { state, header } = auth.issueState();
      return redirect(res, tiktok.authorizeUrl({ redirectUri: redirectUri(req), state }), [header]);
    }
    if (route === 'GET /api/auth/tiktok/callback') {
      const fail = (msg) => redirect(res, `/?auth_error=${encodeURIComponent(msg)}`, [auth.clearState()]);
      if (!tiktok) return fail('TikTok login is not set up.');
      if (q.get('error')) return fail(`TikTok said: ${q.get('error_description') || q.get('error')}`);
      if (!auth.checkState(req, q.get('state'))) return fail('Login expired or was tampered with. Please try again.');
      let tokens;
      let user;
      try {
        tokens = await tiktok.exchangeCode({ code: q.get('code'), redirectUri: redirectUri(req) });
        user = await tiktok.userInfo(tokens.accessToken);
      } catch (err) {
        return fail(err.message);
      }
      if (owner && cleanUser(user.username) !== owner) {
        await tiktok.revoke(tokens.accessToken).catch(() => {});
        return fail(`@${user.username || 'that account'} isn't allowed to use this app.`);
      }
      await account.connect(tokens, user);
      await account.sync().catch(() => {}); // first sync; errors show on the account tab
      const cookies = [auth.clearState()];
      if (cloud && !auth.readSession(req)) cookies.push(auth.issueSession({ sub: user.open_id, via: 'tiktok' }));
      return redirect(res, '/#account', cookies);
    }

    // Everything below needs a logged-in session when running in the cloud.
    if (cloud && !PUBLIC_ROUTES.has(route) && !auth.readSession(req)) throw new HttpError(401, 'Please log in');

    if (route === 'GET /api/trends') {
      const kind = KINDS.includes(q.get('kind')) ? q.get('kind') : 'hashtags';
      const { previous, ...data } = await trends.getTrends({
        kind,
        country: countryParam(q),
        period: periodParam(q),
        refresh: q.get('refresh') === '1',
      });
      return send(res, 200, data);
    }

    if (route === 'GET /api/lookup') {
      const name = cleanHashtag(q.get('name'));
      if (!name) return send(res, 400, { error: 'Enter a hashtag to look up' });
      return send(
        res,
        200,
        await trends.lookupHashtag({ name, country: countryParam(q), period: periodParam(q), refresh: q.get('refresh') === '1' }),
      );
    }

    if (route === 'GET /api/account') {
      return send(res, 200, await accountPayload(account, { timeZone: q.get('tz') || 'UTC', autoSync: true }));
    }
    if (route === 'POST /api/account/sync') {
      if (!account) throw new HttpError(400, 'TikTok login is not set up');
      try {
        await account.sync();
      } catch (err) {
        throw new HttpError(502, err.message);
      }
      return send(res, 200, await accountPayload(account, { timeZone: q.get('tz') || 'UTC' }));
    }
    if (route === 'POST /api/account/disconnect') {
      if (account) await account.disconnect();
      const session = auth.readSession(req);
      const headers = session?.via === 'tiktok' ? { 'set-cookie': auth.clearSession() } : {};
      return send(res, 200, { connected: false, configured: Boolean(account) }, undefined, headers);
    }

    const { search } = ctx;
    if (route === 'GET /api/search-trends') {
      let data = await search.data();
      let refreshError = null;
      if (data.connected && (!data.fetchedAt || Date.now() - data.fetchedAt > 20 * HOUR)) {
        try {
          await refreshSearchTrends(search);
          data = await search.data();
        } catch (err) {
          refreshError = err.message;
        }
      }
      return send(res, 200, { ...data, refreshError, risingPct: RISING_PCT });
    }
    if (route === 'POST /api/search-trends/refresh') {
      try {
        await refreshSearchTrends(search);
      } catch (err) {
        throw new HttpError(err.status ?? 502, err.message);
      }
      return send(res, 200, { ...(await search.data()), risingPct: RISING_PCT });
    }
    if (route === 'PUT /api/search-trends/seeds') {
      await search.saveSeeds((await readBody(req)).seeds);
      try {
        if (await search.isConnected()) await refreshSearchTrends(search);
      } catch {
        // The new keywords are saved; the next refresh will pick them up.
      }
      return send(res, 200, { ...(await search.data()), risingPct: RISING_PCT });
    }
    if (route === 'POST /api/search-trends/disconnect') {
      await search.disconnect();
      return send(res, 200, { ...(await search.data()), risingPct: RISING_PCT });
    }
    if (route === 'GET /api/auth/tiktok-ads') {
      if (!ads.configured) return redirect(res, `/?auth_error=${encodeURIComponent('TikTok Ads is not set up yet (TIKTOK_ADS_APP_ID and TIKTOK_ADS_SECRET).')}#search`);
      const { state, header } = auth.issueState();
      return redirect(res, ads.authorizeUrl({ redirectUri: `${appUrl(req)}/api/auth/tiktok-ads/callback`, state }), [header]);
    }
    if (route === 'GET /api/auth/tiktok-ads/callback') {
      const fail = (msg) => redirect(res, `/?auth_error=${encodeURIComponent(msg)}#search`, [auth.clearState()]);
      if (!ads.configured) return fail('TikTok Ads is not set up.');
      if (!auth.checkState(req, q.get('state'))) return fail('Connection expired or was tampered with. Please try again.');
      const code = q.get('auth_code') || q.get('code');
      if (!code) return fail('TikTok did not send an authorization code.');
      try {
        await search.connect(await ads.exchange(code));
        await refreshSearchTrends(search).catch(() => {});
      } catch (err) {
        return fail(err.message);
      }
      return redirect(res, '/#search', [auth.clearState()]);
    }

    if (route === 'GET /api/watchlist') return send(res, 200, await store.getWatchlist());
    if (route === 'POST /api/watchlist') {
      const b = await readBody(req);
      if (!KINDS.includes(b.kind) || !b.id || !b.name) {
        return send(res, 400, { error: 'kind, id and name are required' });
      }
      const entry = {
        kind: b.kind,
        id: clip(b.id, 100),
        name: clip(b.name),
        subtitle: clip(b.subtitle),
        url: /^https:\/\//.test(b.url ?? '') ? clip(b.url, 500) : null,
        note: clip(b.note, 1000),
      };
      return send(res, 200, await store.addToWatchlist(entry));
    }
    if (route === 'DELETE /api/watchlist') {
      return send(res, 200, await store.removeFromWatchlist(q.get('kind'), q.get('id')));
    }

    if (route === 'GET /api/alerts') return send(res, 200, await alertsPayload());
    if (route === 'PUT /api/alerts/settings') {
      await alerts.saveSettings(await readBody(req));
      return send(res, 200, await alertsPayload());
    }
    if (route === 'POST /api/alerts/run') {
      if (offline) return send(res, 409, { error: 'Checks need live data; the app is running in offline mode.' });
      await alerts.run();
      return send(res, 200, await alertsPayload());
    }
    if (route === 'POST /api/alerts/read') {
      await alerts.markAllRead();
      return send(res, 200, await alertsPayload());
    }
    if (route === 'DELETE /api/alerts/events') {
      await alerts.clearEvents();
      return send(res, 200, await alertsPayload());
    }

    return send(res, 404, { error: 'Not found' });
  }

  async function handleStatic(req, res, url) {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const full = path.resolve(PUBLIC, rel);
    if (!full.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    try {
      const body = await readFile(full);
      send(res, 200, body, MIME[path.extname(full)] ?? 'application/octet-stream');
    } catch {
      send(res, 404, 'Not found', 'text/plain');
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // On Vercel, vercel.json rewrites /api/<anything> to /api/main?__path=<anything>.
    let pathname = url.pathname;
    if (url.searchParams.has('__path')) {
      pathname = `/api/${url.searchParams.get('__path')}`.replace(/\/+$/, '');
      url.searchParams.delete('__path');
    }
    try {
      if (pathname.startsWith('/api/')) await handleApi(req, res, url, pathname);
      else await handleStatic(req, res, url);
    } catch (err) {
      if (!err.status) console.error(err);
      const status = err.status ?? 500;
      send(res, status, { error: err.status ? err.message : 'Internal error' });
    }
  }

  // Locally there's no Vercel cron, so check hourly whether daily work is due.
  function startSchedule({ firstDelayMs = 15_000, everyMs = HOUR } = {}) {
    if (offline) return () => {};
    const tick = () => runDaily().catch((err) => console.error('Scheduled run failed:', err));
    const first = setTimeout(tick, firstDelayMs);
    const timer = setInterval(tick, everyMs);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  return Object.assign(handler, { alerts, startSchedule, runDaily, store, cloud });
}

export function createApp(opts) {
  const handler = createHandler(opts);
  const server = http.createServer(handler);
  server.alerts = handler.alerts;
  server.startSchedule = handler.startSchedule;
  return server;
}
