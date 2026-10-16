// Small JSON document storage. Each document has a name ("watchlist.json")
// and lives either in a folder of files (running on your computer) or in
// Redis (running on Vercel, where the filesystem doesn't persist).
//
// Documents: a response cache, your own rank history (so you can see how a
// trend moved across the times you checked), per-hashtag series, your
// watchlist, alert settings and log, and your TikTok account data.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600_000;

export function fileBackend(dir) {
  const file = (name) => path.join(dir, name);
  return {
    kind: 'file',
    async get(name) {
      try {
        return JSON.parse(await readFile(file(name), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      }
    },
    // Write to a temp file then rename, so a crash never leaves half a file.
    async set(name, value) {
      await mkdir(dir, { recursive: true });
      const tmp = `${file(name)}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2));
      await rename(tmp, file(name));
    },
  };
}

// Upstash Redis over its REST API, so no client library is needed.
// Vercel's Upstash integration sets KV_REST_API_URL / KV_REST_API_TOKEN;
// a direct Upstash setup uses UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
export function redisBackend({ url, token, prefix = 'trendtok:', fetchImpl = globalThis.fetch }) {
  async function command(...args) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Redis error: ${body.error ?? `HTTP ${res.status}`}`);
    return body.result;
  }
  return {
    kind: 'redis',
    async get(name) {
      const raw = await command('GET', prefix + name);
      return raw == null ? undefined : JSON.parse(raw);
    },
    async set(name, value) {
      await command('SET', prefix + name, JSON.stringify(value));
    },
  };
}

export function backendFromEnv(env, { dataDir, fetchImpl } = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisBackend({ url, token, fetchImpl });
  // On Vercel only /tmp is writable, and it's wiped between cold starts.
  if (env.VERCEL) return { ...fileBackend('/tmp/trendtok-data'), kind: 'temporary' };
  return fileBackend(dataDir);
}

export function createStore(dirOrBackend) {
  const backend = typeof dirOrBackend === 'string' ? fileBackend(dirOrBackend) : dirOrBackend;

  async function readJson(name, fallback) {
    const value = await backend.get(name);
    // null means deleted (see account disconnect), same as missing.
    return value == null ? structuredClone(fallback) : value;
  }

  const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, '');
  // Serialize read-modify-write operations so parallel requests in this
  // process don't clobber each other.
  let queue = Promise.resolve();
  const locked = (fn) => (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };

  // Read a document, let fn change it in place, write it back. Returns what fn
  // returned, or the updated value when fn returns nothing.
  const update = locked(async (name, fallback, fn) => {
    const value = await readJson(name, fallback);
    const result = await fn(value);
    await backend.set(name, value);
    return result === undefined ? value : result;
  });

  const cacheName = (key) => `cache-${safe(key.replace(/:/g, '_'))}.json`;
  const historyName = (kind, country, period) =>
    `history-${safe(kind)}-${safe(country)}-${safe(period)}.json`;
  const seriesName = (key) => `series-${safe(key)}.json`;

  return {
    kind: backend.kind,
    read: readJson,
    write: locked((name, value) => backend.set(name, value)),
    update,

    async getCache(key, maxAgeMs) {
      const hit = await backend.get(cacheName(key));
      return hit && Date.now() - hit.at < maxAgeMs ? hit : null;
    },
    setCache: (key, payload) => backend.set(cacheName(key), { at: Date.now(), ...payload }),

    // Records one snapshot of ranks: at most one per hour, keeping the last 500.
    // Also returns the snapshot before this one, which alerts use to spot new entries.
    recordHistory: (kind, country, period, items) =>
      update(historyName(kind, country, period), [], (history) => {
        const last = history.at(-1);
        if (last && Date.now() - last.at < HOUR) {
          return { history: [...history], previous: history.at(-2) ?? null };
        }
        history.push({ at: Date.now(), ranks: Object.fromEntries(items.map((x) => [x.id, x.rank])) });
        history.splice(0, Math.max(0, history.length - 500));
        return { history: [...history], previous: last ?? null };
      }),
    getHistory: (kind, country, period) => readJson(historyName(kind, country, period), []),

    // Numbers over time for one looked-up hashtag. One point per hour at most;
    // a newer reading within the hour replaces the last one.
    appendSeries: (key, point) =>
      update(seriesName(key), [], (series) => {
        const entry = { at: Date.now(), ...point };
        const last = series.at(-1);
        if (last && Date.now() - last.at < HOUR) series[series.length - 1] = entry;
        else series.push(entry);
        series.splice(0, Math.max(0, series.length - 500));
        return [...series];
      }),
    getSeries: (key) => readJson(seriesName(key), []),

    getWatchlist: () => readJson('watchlist.json', []),
    addToWatchlist: (entry) =>
      update('watchlist.json', [], (list) => {
        const i = list.findIndex((x) => x.kind === entry.kind && x.id === entry.id);
        if (i !== -1) list.splice(i, 1);
        list.unshift({ ...entry, addedAt: Date.now() });
      }),
    removeFromWatchlist: (kind, id) =>
      update('watchlist.json', [], (list) => {
        const i = list.findIndex((x) => x.kind === kind && x.id === id);
        if (i !== -1) list.splice(i, 1);
      }),
  };
}
