// Small JSON-file storage under data/: a response cache, your own rank
// history (so you can see how a trend moved across the times you checked),
// per-hashtag series, your watchlist, and the alert settings and log.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600_000;

export function createStore(dir) {
  const file = (name) => path.join(dir, name);

  async function readJson(name, fallback) {
    try {
      return JSON.parse(await readFile(file(name), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(fallback);
      throw err;
    }
  }

  // Write to a temp file then rename, so a crash never leaves half a file.
  async function writeJson(name, value) {
    await mkdir(dir, { recursive: true });
    const tmp = `${file(name)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, file(name));
  }

  const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, '');
  // Serialize read-modify-write operations so parallel requests don't clobber each other.
  let queue = Promise.resolve();
  const locked = (fn) => (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };

  // Read a file, let fn change it in place, write it back. Returns what fn
  // returned, or the updated value when fn returns nothing.
  const update = locked(async (name, fallback, fn) => {
    const value = await readJson(name, fallback);
    const result = await fn(value);
    await writeJson(name, value);
    return result === undefined ? value : result;
  });

  const historyName = (kind, country, period) =>
    `history-${safe(kind)}-${safe(country)}-${safe(period)}.json`;
  const seriesName = (key) => `series-${safe(key)}.json`;

  return {
    read: readJson,
    update,

    async getCache(key, maxAgeMs) {
      const cache = await readJson('cache.json', {});
      const hit = cache[key];
      return hit && Date.now() - hit.at < maxAgeMs ? hit : null;
    },
    setCache: (key, payload) =>
      update('cache.json', {}, (cache) => {
        // Drop entries older than a day so the file doesn't grow forever.
        for (const k of Object.keys(cache)) if (Date.now() - cache[k].at > 24 * HOUR) delete cache[k];
        cache[key] = { at: Date.now(), ...payload };
      }),

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
