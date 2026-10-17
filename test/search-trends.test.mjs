import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRows, cleanSeeds } from '../lib/search-trends.mjs';
import { createTikTokAds } from '../lib/tiktok-ads.mjs';
import { createApp } from '../server.mjs';

const DAY = 86400_000;

test('rows: monthly searches with 7- and 30-day change, rising and new flags', () => {
  const now = Date.UTC(2026, 9, 17);
  const snaps = [
    { at: now - 31 * DAY, volumes: { 'pressure washing': 10000, 'roof cleaning': 4000 } },
    { at: now - 7 * DAY, volumes: { 'pressure washing': 12000, 'roof cleaning': 4000 } },
    { at: now, volumes: { 'pressure washing': 12731, 'roof cleaning': 5200, 'gutter cleaning': 900 } },
  ];
  const rows = buildRows(snaps, ['pressure washing']);
  const byKw = Object.fromEntries(rows.map((r) => [r.keyword, r]));
  assert.deepEqual(rows.map((r) => r.keyword), ['pressure washing', 'roof cleaning', 'gutter cleaning']);
  assert.equal(byKw['pressure washing'].change7d, 6.1);
  assert.equal(byKw['pressure washing'].change30d, 27.3);
  assert.equal(byKw['pressure washing'].seed, true);
  assert.equal(byKw['roof cleaning'].change7d, 30);
  assert.equal(byKw['roof cleaning'].rising, true);
  assert.equal(byKw['gutter cleaning'].isNew, true);
  assert.equal(byKw['gutter cleaning'].change7d, null);
  assert.equal(byKw['pressure washing'].history.length, 3);

  const first = buildRows([{ at: now, volumes: { a: 5 } }]);
  assert.equal(first[0].change7d, null);
  assert.equal(first[0].isNew, false, 'nothing is "new" on day one');
});

test('seeds are cleaned and limited', () => {
  assert.deepEqual(cleanSeeds([' #Pressure  Washing ', 'pressure washing', 'roof!cleaning']), ['pressure washing', 'roof cleaning']);
  assert.throws(() => cleanSeeds(['  ', '#']), /at least one/);
  assert.equal(cleanSeeds(Array.from({ length: 15 }, (_, i) => `kw ${i}`)).length, 10);
});

test('keyword recommend: request format and errors', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: new URL(url), init };
    return Response.json({ code: 0, data: { recommended_keywords: [{ recommended_keyword: 'Pressure Washing', monthly_searches: 12731 }] } });
  };
  const ads = createTikTokAds({ appId: 'a', secret: 's', fetchImpl });
  const rows = await ads.keywordRecommend('tok', '123', ['pressure washing', 'roof cleaning']);
  assert.deepEqual(rows, [{ keyword: 'pressure washing', monthlySearches: 12731 }]);
  assert.equal(seen.url.pathname, '/open_api/v1.3/tool/search_keyword/recommend/');
  assert.equal(seen.init.headers['Access-Token'], 'tok');
  assert.equal(seen.url.searchParams.get('advertiser_id'), '123');
  assert.deepEqual(JSON.parse(seen.url.searchParams.get('search_queries')), ['pressure washing', 'roof cleaning']);
  assert.deepEqual(JSON.parse(seen.url.searchParams.get('regions')), ['US']);

  const bad = createTikTokAds({ appId: 'a', secret: 's', fetchImpl: async () => Response.json({ code: 40105, message: 'Access token is incorrect' }) });
  await assert.rejects(bad.keywordRecommend('x', '1', ['a']), /Access token is incorrect/);
});

async function withServer(env, fetchImpl, fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trendtok-'));
  const server = createApp({ env, dataDir, fetchImpl, delayMs: 0, notify: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (p, init = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), cookie } });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
    if (set.length) cookie = set.join('; ');
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, location: res.headers.get('location') };
  };
  try {
    await fn(call, dataDir);
  } finally {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const recommend = (volumes) => async (url) => {
  if (url.includes('/tool/search_keyword/recommend/')) {
    return Response.json({
      code: 0,
      data: { recommended_keywords: Object.entries(volumes).map(([k, n]) => ({ recommended_keyword: k, monthly_searches: n })) },
    });
  }
  if (url.includes('/oauth2/access_token/')) {
    return Response.json({ code: 0, data: { access_token: 'long-lived-token', advertiser_ids: ['7572318577962008577'], scope: [4] } });
  }
  return new Response('nope', { status: 404 });
};

test('search trends API: refresh, seeds, and one alert per rising search', async () => {
  let volumes = { 'pressure washing': 12000, 'roof cleaning': 1000 };
  const fetchImpl = async (url, init) => recommend(volumes)(url, init);
  const env = { TIKTOK_ADS_ACCESS_TOKEN: 'tok', TIKTOK_ADVERTISER_ID: '123' };
  await withServer(env, fetchImpl, async (call, dataDir) => {
    const first = await call('/api/search-trends');
    assert.equal(first.body.connected, true);
    assert.equal(first.body.viaEnv, true);
    assert.equal(first.body.rows.length, 2);
    assert.equal(first.body.rows[0].keyword, 'pressure washing');

    const seeds = await call('/api/search-trends/seeds', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seeds: ['Pressure Washing', 'gutter cleaning'] }),
    });
    assert.deepEqual(seeds.body.seeds, ['pressure washing', 'gutter cleaning']);
    assert.equal((await call('/api/search-trends/seeds', { method: 'PUT', body: '{"seeds":[]}' })).status, 400);

    // Pretend today's snapshot was taken 8 days ago, then roof cleaning jumps.
    const file = path.join(dataDir, 'search-snapshots.json');
    const snaps = JSON.parse(await readFile(file, 'utf8'));
    snaps[0].at -= 8 * DAY;
    snaps[0].day = 'old';
    await writeFile(file, JSON.stringify(snaps));
    volumes = { 'pressure washing': 12100, 'roof cleaning': 1600 };

    const cron = await call('/api/cron');
    assert.equal(cron.body.search.rising, 1);
    assert.equal(cron.body.search.alerted, 1);
    const alerts = await call('/api/alerts');
    const ev = alerts.body.events.find((e) => e.kind === 'search');
    assert.match(`${ev.name} ${ev.reason}`, /"roof cleaning" searches are up 60% this week/);

    const again = await call('/api/cron');
    assert.equal(again.body.search.alerted, 0, 'no repeat alert within 14 days');
  });
});

test('search trends: connect TikTok Ads through its authorization page', async () => {
  const env = { TIKTOK_ADS_APP_ID: 'app1', TIKTOK_ADS_SECRET: 'sec', APP_URL: 'https://trendtok.example.com' };
  await withServer(env, recommend({ 'pressure washing': 12731 }), async (call, dataDir) => {
    assert.equal((await call('/api/search-trends')).body.connected, false);
    assert.equal((await call('/api/search-trends')).body.configured, true);

    const start = await call('/api/auth/tiktok-ads');
    const auth = new URL(start.location);
    assert.equal(auth.origin + auth.pathname, 'https://business-api.tiktok.com/portal/auth');
    assert.equal(auth.searchParams.get('app_id'), 'app1');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://trendtok.example.com/api/auth/tiktok-ads/callback');

    const forged = await call('/api/auth/tiktok-ads/callback?auth_code=x&state=forged');
    assert.match(decodeURIComponent(forged.location), /tampered/);

    const again = await call('/api/auth/tiktok-ads');
    const state = new URL(again.location).searchParams.get('state');
    const cb = await call(`/api/auth/tiktok-ads/callback?auth_code=abc&state=${state}`);
    assert.equal(cb.location, '/#search');

    const data = await call('/api/search-trends');
    assert.equal(data.body.connected, true);
    assert.equal(data.body.advertiserId, '7572318577962008577');
    assert.equal(data.body.rows[0].searches, 12731);
    const stored = await readFile(path.join(dataDir, 'ads-account.json'), 'utf8');
    assert.doesNotMatch(stored, /long-lived-token/, 'token is stored encrypted');

    await call('/api/search-trends/disconnect', { method: 'POST' });
    assert.equal((await call('/api/search-trends')).body.connected, false);
  });
});
