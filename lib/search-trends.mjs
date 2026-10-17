// Search trends: how many people search TikTok for your keywords each month
// (from TikTok's official Search Ads keyword tool), saved daily so the app can
// show which searches are growing.
//
// TikTok's API gives the current monthly count only. The 7- and 30-day
// changes are worked out from this app's own daily snapshots, so they appear
// once a week or a month of history has been collected.

const DAY = 86400_000;
const MAX_SNAPSHOTS = 90;
const KEEP_KEYWORDS = 150;
const MAX_SEEDS = 10;

export const DEFAULT_SEEDS = ['pressure washing', 'house washing', 'roof cleaning', 'driveway cleaning', 'soft washing'];

// A keyword is "rising" when its monthly searches grew this much in a week.
export const RISING_PCT = 25;
const RISING_MIN_SEARCHES = 500;

export function cleanSeeds(input) {
  if (!Array.isArray(input)) throw Object.assign(new Error('seeds must be a list'), { status: 400 });
  const seeds = [
    ...new Set(
      input
        .map((s) => String(s).toLowerCase().replace(/#/g, '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80))
        .filter(Boolean),
    ),
  ];
  if (!seeds.length) throw Object.assign(new Error('Add at least one keyword'), { status: 400 });
  return seeds.slice(0, MAX_SEEDS);
}

const pct = (now, then) => (then > 0 ? Math.round(((now - then) / then) * 1000) / 10 : null);

// The latest snapshot taken at or before `ms` (with half a day of slack).
function snapshotBefore(snapshots, ms) {
  for (let i = snapshots.length - 1; i >= 0; i--) if (snapshots[i].at <= ms + DAY / 2) return snapshots[i];
  return null;
}

export function buildRows(snapshots, seeds = []) {
  const latest = snapshots.at(-1);
  if (!latest) return [];
  const weekAgo = snapshots.length > 1 ? snapshotBefore(snapshots, latest.at - 7 * DAY) : null;
  const monthAgo = snapshots.length > 1 ? snapshotBefore(snapshots, latest.at - 30 * DAY) : null;
  const historyDays = (latest.at - snapshots[0].at) / DAY;
  const seedSet = new Set(seeds);
  return Object.entries(latest.volumes)
    .map(([keyword, searches]) => {
      const w = weekAgo && weekAgo !== latest ? weekAgo.volumes[keyword] : undefined;
      const m = monthAgo && monthAgo !== latest ? monthAgo.volumes[keyword] : undefined;
      const change7d = w != null ? pct(searches, w) : null;
      return {
        keyword,
        searches,
        change7d,
        change30d: m != null ? pct(searches, m) : null,
        isNew: historyDays >= 7 && weekAgo && w == null,
        rising: change7d != null && change7d >= RISING_PCT && searches >= RISING_MIN_SEARCHES,
        seed: seedSet.has(keyword),
        history: snapshots.slice(-60).filter((s) => s.volumes[keyword] != null).map((s) => ({ t: s.at / 1000, v: s.volumes[keyword] })),
      };
    })
    .sort((a, b) => b.searches - a.searches);
}

export function createSearchTrends({ store, ads, auth, env = {} }) {
  const envToken = env.TIKTOK_ADS_ACCESS_TOKEN || null;
  const envAdvertiser = env.TIKTOK_ADVERTISER_ID || null;

  async function credentials() {
    if (envToken && envAdvertiser) return { token: envToken, advertiserId: envAdvertiser };
    const acct = await store.read('ads-account.json', null);
    if (!acct?.token) return null;
    return { token: auth.decrypt(acct.token), advertiserId: envAdvertiser || acct.advertiserId };
  }

  const getSeeds = async () => (await store.read('search-seeds.json', null))?.seeds ?? DEFAULT_SEEDS;

  async function refresh() {
    const creds = await credentials();
    if (!creds) throw Object.assign(new Error('TikTok Ads is not connected'), { status: 400 });
    const seeds = await getSeeds();
    const volumes = {};
    // The API takes 5 queries at a time.
    for (let i = 0; i < seeds.length; i += 5) {
      const rows = await ads.keywordRecommend(creds.token, creds.advertiserId, seeds.slice(i, i + 5));
      for (const r of rows) volumes[r.keyword] = Math.max(volumes[r.keyword] ?? 0, r.monthlySearches);
    }
    // Keep the biggest keywords plus your own seeds, to keep storage small.
    const keep = Object.entries(volumes)
      .sort((a, b) => b[1] - a[1])
      .filter(([k], i) => i < KEEP_KEYWORDS || seeds.includes(k));
    const snapshot = { at: Date.now(), day: new Date().toISOString().slice(0, 10), volumes: Object.fromEntries(keep) };
    const snapshots = await store.update('search-snapshots.json', [], (snaps) => {
      if (snaps.at(-1)?.day === snapshot.day) snaps[snaps.length - 1] = snapshot;
      else snaps.push(snapshot);
      snaps.splice(0, Math.max(0, snaps.length - MAX_SNAPSHOTS));
      return [...snaps];
    });
    const rows = buildRows(snapshots, seeds);
    return { at: snapshot.at, keywords: rows.length, rising: rows.filter((r) => r.rising) };
  }

  return {
    refresh,
    getSeeds,
    saveSeeds: async (input) => {
      const seeds = cleanSeeds(input);
      await store.write('search-seeds.json', { seeds });
      return seeds;
    },

    async connect({ accessToken, advertiserIds }) {
      if (!advertiserIds?.length && !envAdvertiser) throw new Error('That TikTok account has no ad accounts. Create one in TikTok Ads Manager first.');
      await store.write('ads-account.json', {
        token: auth.encrypt(accessToken),
        advertiserId: envAdvertiser || advertiserIds[0],
        advertiserIds,
        connectedAt: Date.now(),
      });
    },
    disconnect: () => store.write('ads-account.json', null),
    isConnected: async () => Boolean(await credentials()),

    async data() {
      const [creds, seeds, snapshots] = await Promise.all([credentials(), getSeeds(), store.read('search-snapshots.json', [])]);
      const acct = await store.read('ads-account.json', null);
      return {
        configured: Boolean(ads?.configured || (envToken && envAdvertiser)),
        connected: Boolean(creds),
        viaEnv: Boolean(envToken && envAdvertiser),
        advertiserId: creds?.advertiserId ?? null,
        connectedAt: acct?.connectedAt ?? null,
        seeds,
        fetchedAt: snapshots.at(-1)?.at ?? null,
        historyDays: snapshots.length ? Math.round((snapshots.at(-1).at - snapshots[0].at) / DAY) : 0,
        rows: buildRows(snapshots, seeds),
      };
    },
  };
}
