// TrendTok Local: a zero-dependency Node server that serves the UI from
// public/ and a small JSON API under /api.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLive } from './lib/creative-center.mjs';
import { sampleData } from './lib/sample-data.mjs';
import { createStore } from './lib/store.mjs';
import { KINDS } from './lib/normalize.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PERIODS = [7, 30, 120];
const CACHE_MS = 30 * 60 * 1000;

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

export function createApp({ dataDir = path.join(ROOT, 'data'), offline = false, fetchImpl } = {}) {
  const store = createStore(dataDir);

  async function getTrends(q) {
    const kind = KINDS.includes(q.get('kind')) ? q.get('kind') : 'hashtags';
    const country = /^[A-Z]{2}$/.test(q.get('country') ?? '') ? q.get('country') : 'US';
    const period = PERIODS.includes(Number(q.get('period'))) ? Number(q.get('period')) : 7;
    const wantSample = offline || q.get('source') === 'sample';
    const refresh = q.get('refresh') === '1';
    const key = `${kind}:${country}:${period}`;
    let result;

    if (wantSample) {
      result = { source: 'sample', fetchedAt: Date.now(), items: sampleData(kind, { country, period }) };
    } else {
      const cached = refresh ? null : await store.getCache(key, CACHE_MS);
      if (cached) {
        result = { source: 'cache', fetchedAt: cached.at, items: cached.items };
      } else {
        try {
          const live = await fetchLive(kind, { country, period }, fetchImpl);
          await store.setCache(key, { items: live.items });
          result = { source: 'live', fetchedAt: Date.now(), items: live.items };
        } catch (err) {
          result = {
            source: 'sample',
            fetchedAt: Date.now(),
            warning: `Live data unavailable (${err.message}). Showing sample data.`,
            items: sampleData(kind, { country, period }),
          };
        }
      }
    }

    // Only real data goes into your history; sample ranks would pollute it.
    const history =
      result.source === 'sample'
        ? []
        : result.source === 'live'
          ? await store.recordHistory(kind, country, period, result.items)
          : await store.getHistory(kind, country, period);
    const items = result.items.map((item) => ({
      ...item,
      seen: history
        .filter((h) => h.ranks[item.id] != null)
        .slice(-60)
        .map((h) => ({ at: h.at, rank: h.ranks[item.id] })),
    }));
    return { kind, country, period, ...result, items };
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/trends' && req.method === 'GET') {
      return send(res, 200, await getTrends(url.searchParams));
    }
    if (url.pathname === '/api/watchlist') {
      if (req.method === 'GET') return send(res, 200, await store.getWatchlist());
      if (req.method === 'POST') {
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
      if (req.method === 'DELETE') {
        return send(
          res,
          200,
          await store.removeFromWatchlist(url.searchParams.get('kind'), url.searchParams.get('id')),
        );
      }
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

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(req, res, url);
    } catch (err) {
      console.error(err);
      send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5173;
  const host = process.env.HOST || '127.0.0.1';
  const offline = process.argv.includes('--offline') || process.env.TRENDTOK_OFFLINE === '1';
  createApp({ offline }).listen(port, host, () => {
    console.log(`TrendTok Local running at http://${host}:${port}${offline ? ' (offline sample data)' : ''}`);
  });
}
