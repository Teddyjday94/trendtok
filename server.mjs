// TrendTok Local: a zero-dependency Node server that serves the UI from
// public/ and a small JSON API under /api.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.mjs';
import { createTrendService } from './lib/trends.mjs';
import { createAlerts } from './lib/alerts.mjs';
import { cleanHashtag } from './lib/hashtag-lookup.mjs';
import { desktopNotify } from './lib/notify.mjs';
import { KINDS } from './lib/normalize.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PERIODS = [7, 30, 120];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

const clip = (v, max = 300) => (v == null ? null : String(v).slice(0, max));
const countryParam = (q) => (/^[A-Z]{2}$/.test(q.get('country') ?? '') ? q.get('country') : 'US');
const periodParam = (q) => (PERIODS.includes(Number(q.get('period'))) ? Number(q.get('period')) : 7);

export function createApp({
  dataDir = path.join(ROOT, 'data'),
  offline = false,
  fetchImpl,
  notify = desktopNotify,
  delayMs,
} = {}) {
  const store = createStore(dataDir);
  const trends = createTrendService({ store, offline, fetchImpl });
  const alerts = createAlerts({ store, trends, notify, offline, delayMs });

  async function alertsPayload() {
    const [settings, events] = await Promise.all([alerts.getSettings(), alerts.getEvents()]);
    return { settings, events, unread: events.filter((e) => !e.read).length, running: alerts.isRunning(), offline };
  }

  async function handleApi(req, res, url) {
    const q = url.searchParams;
    const route = `${req.method} ${url.pathname}`;

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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(req, res, url);
    } catch (err) {
      if (!err.status) console.error(err);
      send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error' });
    }
  });
  server.alerts = alerts;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5173;
  const host = process.env.HOST || '127.0.0.1';
  const offline = process.argv.includes('--offline') || process.env.TRENDTOK_OFFLINE === '1';
  const server = createApp({ offline });
  server.listen(port, host, () => {
    console.log(`TrendTok Local running at http://${host}:${port}${offline ? ' (offline sample data)' : ''}`);
    if (!offline) server.alerts.startSchedule();
  });
}
