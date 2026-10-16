// Small JSON-file storage under data/: a response cache, your own rank
// history (so you can see how a trend moved across the times you checked),
// and your watchlist.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function createStore(dir) {
  const file = (name) => path.join(dir, name);

  async function readJson(name, fallback) {
    try {
      return JSON.parse(await readFile(file(name), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
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

  const historyName = (kind, country, period) =>
    `history-${safe(kind)}-${safe(country)}-${safe(period)}.json`;

  return {
    async getCache(key, maxAgeMs) {
      const cache = await readJson('cache.json', {});
      const hit = cache[key];
      return hit && Date.now() - hit.at < maxAgeMs ? hit : null;
    },
    setCache: locked(async (key, payload) => {
      const cache = await readJson('cache.json', {});
      cache[key] = { at: Date.now(), ...payload };
      await writeJson('cache.json', cache);
    }),

    // Records one snapshot of ranks. Keeps at most one per hour, and the last 500.
    recordHistory: locked(async (kind, country, period, items) => {
      const name = historyName(kind, country, period);
      const history = await readJson(name, []);
      const last = history.at(-1);
      if (last && Date.now() - last.at < 3600_000) return history;
      history.push({ at: Date.now(), ranks: Object.fromEntries(items.map((x) => [x.id, x.rank])) });
      await writeJson(name, history.slice(-500));
      return history;
    }),
    async getHistory(kind, country, period) {
      return readJson(historyName(kind, country, period), []);
    },

    async getWatchlist() {
      return readJson('watchlist.json', []);
    },
    addToWatchlist: locked(async (entry) => {
      const list = await readJson('watchlist.json', []);
      const key = `${entry.kind}:${entry.id}`;
      const next = list.filter((x) => `${x.kind}:${x.id}` !== key);
      next.unshift({ ...entry, addedAt: Date.now() });
      await writeJson('watchlist.json', next);
      return next;
    }),
    removeFromWatchlist: locked(async (kind, id) => {
      const list = await readJson('watchlist.json', []);
      const next = list.filter((x) => !(x.kind === kind && x.id === id));
      await writeJson('watchlist.json', next);
      return next;
    }),
  };
}
