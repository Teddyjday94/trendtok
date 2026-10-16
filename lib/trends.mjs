// Loading trend data: live from Creative Center, or from the cache. When TikTok
// has nothing public to give, the result says so (source "unavailable") rather
// than showing made-up numbers. Sample data is only used in offline mode.
// Used by the API and by the daily collector.
import { fetchLive } from './creative-center.mjs';
import { fetchHashtagDetail } from './hashtag-lookup.mjs';
import { sampleData, sampleHashtagDetail } from './sample-data.mjs';

const CACHE_MS = 30 * 60 * 1000;

export function createTrendService({ store, offline = false, fetchImpl, cacheMs = CACHE_MS }) {
  async function getTrends({ kind, country, period, refresh = false }) {
    const key = `${kind}:${country}:${period}`;
    let result;

    if (offline) {
      result = { source: 'sample', fetchedAt: Date.now(), items: sampleData(kind, { country, period }) };
    } else {
      const cached = refresh ? null : await store.getCache(key, cacheMs);
      if (cached) {
        result = { source: 'cache', fetchedAt: cached.at, items: cached.items, note: cached.note };
      } else {
        try {
          const live = await fetchLive(kind, { country, period }, fetchImpl);
          await store.setCache(key, { items: live.items, note: live.note });
          result = { source: 'live', fetchedAt: Date.now(), items: live.items, note: live.note };
        } catch (err) {
          result = {
            source: 'unavailable',
            fetchedAt: Date.now(),
            error: err.message,
            loginRequired: Boolean(err.loginRequired),
            items: [],
          };
        }
      }
    }

    // Only real data goes into your history; sample ranks would pollute it.
    let history = [];
    let previous = null;
    if (result.source === 'live') {
      ({ history, previous } = await store.recordHistory(kind, country, period, result.items));
    } else if (result.source === 'cache') {
      history = await store.getHistory(kind, country, period);
    }
    const items = result.items.map((item) => ({
      ...item,
      seen: history
        .filter((h) => h.ranks[item.id] != null)
        .slice(-60)
        .map((h) => ({ at: h.at, rank: h.ranks[item.id] })),
    }));
    return { kind, country, period, ...result, items, previous };
  }

  async function lookupHashtag({ name, country, period, refresh = false }) {
    const key = `lookup:${name}:${country}:${period}`;
    const seriesKey = `hashtag-${name}-${country}`;
    const base = { name, country, period };

    if (offline) {
      return { ...base, source: 'sample', fetchedAt: Date.now(), detail: sampleHashtagDetail(name, { country, period }), series: [] };
    }
    const cached = refresh ? null : await store.getCache(key, cacheMs);
    if (cached) {
      return { ...base, source: 'cache', fetchedAt: cached.at, detail: cached.detail, series: await store.getSeries(seriesKey) };
    }
    try {
      const { detail } = await fetchHashtagDetail(name, { country, period }, fetchImpl);
      await store.setCache(key, { detail });
      const series = await store.appendSeries(seriesKey, {
        views: detail.views,
        posts: detail.postsInPeriod ?? detail.posts,
        momentum: detail.momentum,
        rank: detail.rank,
      });
      return { ...base, source: 'live', fetchedAt: Date.now(), detail, series };
    } catch (err) {
      if (err.notFound) return { ...base, source: 'live', fetchedAt: Date.now(), notFound: true, message: err.message, detail: null, series: [] };
      return { ...base, source: 'unavailable', fetchedAt: Date.now(), error: err.message, notFound: true, message: err.message, detail: null, series: [] };
    }
  }

  return { getTrends, lookupHashtag };
}
