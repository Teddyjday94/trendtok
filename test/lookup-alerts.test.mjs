import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDetail, cleanHashtag, buildDetailUrl } from '../lib/hashtag-lookup.mjs';
import { matchKeyword, validateSettings, createAlerts } from '../lib/alerts.mjs';
import { createStore } from '../lib/store.mjs';
import { sampleHashtagDetail } from '../lib/sample-data.mjs';
import { createApp } from '../server.mjs';

const page = (data) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
const curve = (vals) => vals.map((value, i) => ({ time: 1_700_000_000 + i * 86400, value }));
const RISING = curve([0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 0.9]);
const FLAT = curve([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);

const detailPage = (name, trend = FLAT) =>
  page({
    props: {
      pageProps: {
        data: {
          info: {
            hashtag_name: name,
            hashtag_id: '42',
            rank: 12,
            posts_last_period: 3400,
            publish_cnt_all: 98000,
            video_views: 2.1e7,
            video_views_all: 4.4e8,
            trend,
            audience_ages: [
              { age_level: 3, score: 0.41 },
              { age_level: 4, score: 0.37 },
              { age_level: 5, score: 0.22 },
            ],
            audience_countries: [{ country_info: { id: 'US', value: 'United States' }, score: 0.8 }],
            related_hashtags: [{ hashtag_name: 'cleantok' }, { hashtag_name: name }, { hashtag_name: 'satisfying' }],
          },
        },
      },
    },
  });

const listPage = (items) => page({ props: { pageProps: { data: { list: items } } } });

test('cleans hashtag input', () => {
  assert.equal(cleanHashtag('  #PressureWashing!! '), 'pressurewashing');
  assert.equal(cleanHashtag('pressure washing'), 'pressurewashing');
  assert.equal(cleanHashtag('##'), '');
  assert.match(buildDetailUrl('foodtok', { country: 'GB', period: 30 }), /hashtag\/foodtok\/pc\/en\?countryCode=GB&period=30$/);
});

test('parses a hashtag detail page', () => {
  const html = detailPage('pressurewashing', RISING);
  const data = JSON.parse(html.match(/>(\{.*\})</)[1]);
  const d = parseDetail('pressurewashing', data);
  assert.equal(d.name, '#pressurewashing');
  assert.equal(d.rank, 12);
  assert.equal(d.postsInPeriod, 3400);
  assert.equal(d.viewsTotal, 4.4e8);
  assert.deepEqual(d.related, ['cleantok', 'satisfying']);
  assert.deepEqual(d.audienceAges[0], { label: '18–24', share: 41 });
  assert.deepEqual(d.audienceCountries[0], { label: 'United States', share: 80 });
  assert.equal(d.status, 'breakout');
  assert.equal(parseDetail('other', data), null);
});

test('sample detail works for unknown hashtags', () => {
  const d = sampleHashtagDetail('somethingnew', { country: 'CA', period: 7 });
  assert.equal(d.name, '#somethingnew');
  assert.ok(d.related.length > 0);
  assert.equal(new Set(d.audienceCountries.map((c) => c.label)).size, d.audienceCountries.length);
});

test('keyword matching ignores case, spaces and #', () => {
  assert.equal(matchKeyword({ name: '#pressurewashing' }, ['pressure washing']), 'pressure washing');
  assert.equal(matchKeyword({ name: 'Satisfying Clean ASMR', subtitle: 'washsounds' }, ['clean asmr']), 'clean asmr');
  assert.equal(matchKeyword({ name: '#foodtok' }, ['cleantok']), null);
});

test('settings validation', () => {
  const s = validateSettings({ keywords: ['#CleanTok', 'cleantok', ' Pressure  Washing '], countries: ['US', 'GB'], intervalHours: 12 });
  assert.deepEqual(s.keywords, ['cleantok', 'pressure washing']);
  assert.deepEqual(s.countries, ['US', 'GB']);
  assert.throws(() => validateSettings({ countries: ['US', 'GB', 'CA', 'AU'] }), /between 1 and 3/);
  assert.throws(() => validateSettings({ intervalHours: 1 }), /intervalHours/);
});

async function withServer(opts, fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trendtok-'));
  const server = createApp({ dataDir, delayMs: 0, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, init) => {
    const res = await fetch(base + p, init);
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('lookup API: live, not found and fallback', async () => {
  let mode = 'live';
  const fetchImpl = async (url) => {
    if (mode === 'down') return new Response('nope', { status: 503 });
    if (url.includes('/hashtag/pressurewashing/')) return new Response(detailPage('pressurewashing'));
    return new Response(page({ props: { pageProps: {} } }));
  };
  await withServer({ fetchImpl }, async (call) => {
    const live = await call('/api/lookup?name=%23PressureWashing&country=US&period=7');
    assert.equal(live.body.source, 'live');
    assert.equal(live.body.detail.name, '#pressurewashing');
    assert.equal(live.body.series.length, 1);

    const missing = await call('/api/lookup?name=zzzz');
    assert.equal(missing.body.notFound, true);

    mode = 'down';
    const fallback = await call('/api/lookup?name=brandnewtag');
    assert.equal(fallback.body.source, 'sample');
    assert.match(fallback.body.warning, /HTTP 503/);

    assert.equal((await call('/api/lookup?name=%23%23')).status, 400);
  });
});

test('alerts: chart entry, no repeats, then breakout; desktop notification sent', async () => {
  let cleantokTrend = FLAT;
  let tagTrend = FLAT;
  const fetchImpl = async (url) => {
    if (url.includes('/popular/hashtag/')) {
      return new Response(
        listPage([
          { hashtag_id: '1', hashtag_name: 'fyp', rank: 1, trend: FLAT },
          { hashtag_id: '2', hashtag_name: 'cleantok', rank: 2, trend: cleantokTrend },
        ]),
      );
    }
    if (url.includes('/hashtag/pressurewashing/')) return new Response(detailPage('pressurewashing', tagTrend));
    if (url.includes('/hashtag/cleantok/')) return new Response(detailPage('cleantok', cleantokTrend));
    return new Response(listPage([])); // other charts: empty, counted as errors
  };
  const notes = [];
  const notify = (title, message) => notes.push({ title, message });

  await withServer({ fetchImpl, notify }, async (call) => {
    const bad = await call('/api/alerts/settings', { method: 'PUT', body: JSON.stringify({ countries: ['US', 'GB', 'CA', 'AU'] }) });
    assert.equal(bad.status, 400);

    await call('/api/alerts/settings', {
      method: 'PUT',
      body: JSON.stringify({ keywords: ['cleantok', 'pressure washing'], countries: ['US'] }),
    });

    const first = await call('/api/alerts/run', { method: 'POST' });
    assert.equal(first.body.events.length, 1);
    assert.match(first.body.events[0].reason, /on the US hashtag chart at #2/);
    assert.equal(first.body.unread, 1);
    assert.equal(first.body.settings.lastResult.charts, 1);
    assert.equal(notes.length, 1);

    const second = await call('/api/alerts/run', { method: 'POST' });
    assert.equal(second.body.events.length, 1, 'no duplicate alert for the same chart entry');

    cleantokTrend = RISING;
    tagTrend = RISING;
    const third = await call('/api/alerts/run', { method: 'POST' });
    const reasons = third.body.events.map((e) => `${e.name} ${e.reason}`);
    assert.ok(reasons.some((r) => /#cleantok turned Breakout at #2/.test(r)), reasons.join('; '));
    assert.ok(reasons.some((r) => /#pressurewashing turned Breakout in US/.test(r)), reasons.join('; '));
    assert.equal(notes.at(-1).title, '3 new trend alerts');

    const read = await call('/api/alerts/read', { method: 'POST' });
    assert.equal(read.body.unread, 0);
    const cleared = await call('/api/alerts/events', { method: 'DELETE' });
    assert.equal(cleared.body.events.length, 0);
  });
});

test('alerts: scheduled run only when due, and never in offline mode', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trendtok-'));
  try {
    const store = createStore(dataDir);
    let runs = 0;
    const trends = {
      getTrends: async () => {
        runs++;
        return { source: 'live', items: [] };
      },
      lookupHashtag: async () => ({ source: 'live', detail: null }),
    };
    const alerts = createAlerts({ store, trends, delayMs: 0 });
    assert.ok(await alerts.runIfDue(), 'first check runs');
    const afterFirst = runs;
    assert.equal(await alerts.runIfDue(), null, 'not due again within the interval');
    assert.equal(runs, afterFirst);

    // Two overlapping manual runs share one check.
    const [a, b] = [alerts.run(), alerts.run()];
    assert.equal(a, b);
    await a;

    const offline = createAlerts({ store, trends, delayMs: 0, offline: true });
    await store.update('alerts.json', {}, (s) => void (s.lastRun = 0));
    assert.equal(await offline.runIfDue(), null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  await withServer({ offline: true }, async (call) => {
    assert.equal((await call('/api/alerts/run', { method: 'POST' })).status, 409);
  });
});
