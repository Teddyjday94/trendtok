import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scoreMomentum } from '../lib/momentum.mjs';
import { fetchLive } from '../lib/creative-center.mjs';
import { ccItem, ccList } from './cc-fixtures.mjs';
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

test('reads the public hashtag list and normalizes it', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), headers: init.headers };
    return ccList([ccItem('foodtok', 1, [20, 50, 90]), ccItem('newtag', 2), ccItem('falling', 3, [90, 50, 10])]);
  };
  const { items, note } = await fetchLive('hashtags', { country: 'GB', period: 30 }, fetchImpl);
  assert.equal(sent.url, 'https://ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList');
  assert.deepEqual(sent.body, { timeRange: 30, countryCode: 'GB', page: 1, limit: 20 });
  assert.equal(sent.headers['agw-js-conv'], 'str');
  assert.equal(items.length, 3);
  assert.equal(items[0].name, '#foodtok');
  assert.equal(items[0].rank, 1);
  assert.equal(items[0].posts, 1000);
  assert.equal(items[0].url, 'https://www.tiktok.com/tag/foodtok');
  assert.deepEqual(items[0].trend.map((p) => p.v), [20, 50, 90]);
  assert.ok(items[0].momentum > items[2].momentum);
  assert.match(note, /top 3/);
});

test('says plainly when TikTok has no public data', async () => {
  await assert.rejects(fetchLive('sounds', {}, async () => assert.fail('no request expected')), (e) => e.loginRequired && /logged in/.test(e.message));
  await assert.rejects(fetchLive('hashtags', { period: 120 }, async () => ccList([])), (e) => e.loginRequired && /120-day/.test(e.message));
  const invalid = async () => Response.json({ BaseResp: { StatusCode: 38001001, StatusMessage: 'InvalidLogin' } });
  await assert.rejects(fetchLive('hashtags', {}, invalid), (e) => e.loginRequired && /InvalidLogin/.test(e.message));
});

test('normalizes rank moves and trend order from older-style records', () => {
  const a = normalizeItem('hashtags', { hashtag_id: '1', hashtag_name: 'foodtok', rank_diff_type: 1, rank_diff: 3, industry_info: { value: 'Food' },
    trend: [{ time: 2, value: 0.5 }, { time: 1, value: 0.2 }, { time: 3, value: 0.9 }] }, 0);
  assert.equal(a.rankChange, 3);
  assert.equal(a.industry, 'Food');
  assert.deepEqual(a.trend.map((p) => p.t), [1, 2, 3]);
  assert.equal(normalizeItem('hashtags', { hashtag_name: 'x', rank_diff_type: 4 }, 0).isNew, true);
  assert.equal(normalizeItem('hashtags', { hashtag_name: 'y', rank_diff_type: 3, rank_diff: 7 }, 0).rankChange, -7);
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
    return ccList([ccItem('foodtok', 1), ccItem('newtag', 2), ccItem('falling', 3)]);
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

test('reports unavailable data instead of making it up', async () => {
  const fetchImpl = async () => new Response('blocked', { status: 403 });
  await withServer({ fetchImpl }, async (base) => {
    const tags = await (await fetch(`${base}/api/trends?kind=hashtags`)).json();
    assert.equal(tags.source, 'unavailable');
    assert.match(tags.error, /HTTP 403/);
    assert.deepEqual(tags.items, []);
    const sounds = await (await fetch(`${base}/api/trends?kind=sounds`)).json();
    assert.equal(sounds.source, 'unavailable');
    assert.equal(sounds.loginRequired, true);
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
