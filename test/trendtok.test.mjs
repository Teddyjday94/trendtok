import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scoreMomentum } from '../lib/momentum.mjs';
import { extractNextData, findRecords, buildUrl } from '../lib/creative-center.mjs';
import { normalizeItem } from '../lib/normalize.mjs';
import { sampleData } from '../lib/sample-data.mjs';
import { createApp } from '../server.mjs';

const curve = (vals) => vals.map((v, i) => ({ t: i, v }));

test('momentum rates a climbing curve above a falling one', () => {
  const up = scoreMomentum({ trend: curve([0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 0.9]) });
  const down = scoreMomentum({ trend: curve([0.9, 0.8, 0.6, 0.5, 0.3, 0.2, 0.1]) });
  assert.ok(up.momentum > down.momentum);
  assert.equal(up.status, 'breakout');
  assert.equal(down.status, 'cooling');
});

test('momentum stays within 0-100 for extreme input', () => {
  const { momentum } = scoreMomentum({ trend: curve([0, 0, 0, 1, 1, 1]), rankChange: 500, isNew: true });
  assert.ok(momentum >= 0 && momentum <= 100);
  assert.equal(scoreMomentum({}).momentum, 50);
});

// A cut-down page in the shape Creative Center serves: list nested deep in __NEXT_DATA__.
const page = (data) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
const nextData = {
  props: {
    pageProps: {
      industries: [{ id: 1, value: 'Food' }],
      data: {
        pagination: { page: 1 },
        list: [
          { hashtag_id: '1', hashtag_name: 'foodtok', rank: 1, publish_cnt: 1000, video_views: 5e6,
            rank_diff_type: 1, rank_diff: 3, industry_info: { id: 1, value: 'Food' },
            trend: [{ time: 2, value: 0.5 }, { time: 1, value: 0.2 }, { time: 3, value: 0.9 }] },
          { hashtag_id: '2', hashtag_name: 'newtag', rank: 2, rank_diff_type: 4 },
          { hashtag_id: '3', hashtag_name: 'falling', rank: 3, rank_diff_type: 3, rank_diff: 7 },
        ],
      },
    },
  },
};

test('finds the hashtag list wherever it sits in the page data', () => {
  const data = extractNextData(page(nextData));
  const recs = findRecords('hashtags', data);
  assert.equal(recs.length, 3);
  assert.equal(findRecords('sounds', data).length, 0);
  assert.equal(extractNextData('<html>no data</html>'), null);
});

test('normalizes rank moves, trend order and industry', () => {
  const [a, b, c] = findRecords('hashtags', nextData).map((r, i) => normalizeItem('hashtags', r, i));
  assert.equal(a.name, '#foodtok');
  assert.equal(a.rankChange, 3);
  assert.equal(a.industry, 'Food');
  assert.deepEqual(a.trend.map((p) => p.t), [1, 2, 3]);
  assert.equal(a.url, 'https://www.tiktok.com/tag/foodtok');
  assert.equal(b.isNew, true);
  assert.equal(c.rankChange, -7);
});

test('builds Creative Center URLs per kind', () => {
  assert.match(buildUrl('sounds', { country: 'GB', period: 30 }), /popular\/music\/pc\/en\?countryCode=GB&period=30$/);
});

test('sample data is stable and covers every kind', () => {
  for (const kind of ['hashtags', 'sounds', 'creators', 'videos']) {
    const a = sampleData(kind, { country: 'US', period: 7 });
    assert.ok(a.length >= 10, kind);
    assert.deepEqual(a.map((x) => x.id), sampleData(kind, { country: 'US', period: 7 }).map((x) => x.id));
  }
});

async function withServer(opts, fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trendtok-'));
  const server = createApp({ dataDir, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('serves live data, caches it and records rank history', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(page(nextData), { status: 200 });
  };
  await withServer({ fetchImpl }, async (base) => {
    const first = await (await fetch(`${base}/api/trends?kind=hashtags&country=US&period=7`)).json();
    assert.equal(first.source, 'live');
    assert.equal(first.items.length, 3);
    assert.equal(first.items[0].seen.length, 1);
    const second = await (await fetch(`${base}/api/trends?kind=hashtags&country=US&period=7`)).json();
    assert.equal(second.source, 'cache');
    assert.equal(calls, 1);
  });
});

test('falls back to sample data with a warning when TikTok is unreachable', async () => {
  const fetchImpl = async () => new Response('blocked', { status: 403 });
  await withServer({ fetchImpl }, async (base) => {
    const body = await (await fetch(`${base}/api/trends?kind=sounds`)).json();
    assert.equal(body.source, 'sample');
    assert.match(body.warning, /HTTP 403/);
    assert.ok(body.items.length > 0);
  });
});

test('watchlist add, list and remove', async () => {
  await withServer({ offline: true }, async (base) => {
    const add = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'hashtags', id: '1', name: '#foodtok', url: 'javascript:alert(1)', note: 'film Friday' }),
    });
    const list = await add.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].url, null);
    const bad = await fetch(`${base}/api/watchlist`, { method: 'POST', body: '{"kind":"nope"}' });
    assert.equal(bad.status, 400);
    const after = await (await fetch(`${base}/api/watchlist?kind=hashtags&id=1`, { method: 'DELETE' })).json();
    assert.deepEqual(after, []);
  });
});

test('static files are served and path traversal is refused', async () => {
  await withServer({ offline: true }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /TrendTok/);
    const evil = await fetch(`${base}/..%2Fserver.mjs`);
    assert.notEqual(evil.status, 200);
  });
});
