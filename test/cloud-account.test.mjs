import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../lib/auth.mjs';
import { redisBackend, createStore } from '../lib/store.mjs';
import { analyze, hashtagsOf } from '../lib/analysis.mjs';
import { createApp } from '../server.mjs';
import { ccItem, ccList } from './cc-fixtures.mjs';

const SECRET = 'x'.repeat(40);
const DAY = 86400_000;

test('sessions: round trip, tampering and expiry', () => {
  const auth = createAuth({ secret: SECRET });
  const cookie = auth.issueSession({ sub: 'me', via: 'password' }).split(';')[0];
  const req = (c) => ({ headers: { cookie: c } });
  assert.equal(auth.readSession(req(cookie)).sub, 'me');
  const [name, value] = cookie.split('=');
  const [body, mac] = value.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'evil', exp: Date.now() + DAY })).toString('base64url');
  assert.equal(auth.readSession(req(`${name}=${forged}.${mac}`)), null);
  assert.equal(auth.readSession(req(`${name}=${body}.AAAA`)), null);
  assert.equal(createAuth({ secret: 'y'.repeat(40) }).readSession(req(cookie)), null);
  assert.throws(() => createAuth({ secret: 'short' }), /32 characters/);
});

test('token encryption round trip and tamper detection', () => {
  const auth = createAuth({ secret: SECRET });
  const sealed = auth.encrypt('act.secret-token');
  assert.doesNotMatch(sealed, /secret-token/);
  assert.equal(auth.decrypt(sealed), 'act.secret-token');
  const parts = sealed.split('.');
  parts[2] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => auth.decrypt(parts.join('.')));
});

// In-memory stand-in for Upstash's REST API.
function fakeRedis(url = 'https://fake-redis.test') {
  const data = new Map();
  return {
    url,
    data,
    handles: (u) => u === url,
    async handle(init) {
      const [cmd, key, value] = JSON.parse(init.body);
      if (cmd === 'GET') return Response.json({ result: data.get(key) ?? null });
      if (cmd === 'SET') {
        data.set(key, value);
        return Response.json({ result: 'OK' });
      }
      return Response.json({ error: 'unknown command' }, { status: 400 });
    },
  };
}

test('redis backend stores JSON documents', async () => {
  const redis = fakeRedis();
  const fetchImpl = (u, init) => redis.handle(init);
  const store = createStore(redisBackend({ url: redis.url, token: 't', fetchImpl }));
  await store.addToWatchlist({ kind: 'hashtags', id: '1', name: '#a' });
  assert.equal((await store.getWatchlist())[0].name, '#a');
  assert.ok(redis.data.has('trendtok:watchlist.json'));
  await store.write('watchlist.json', null);
  assert.deepEqual(await store.getWatchlist(), []);
});

test('analysis: best time, hashtags, length, taking off and trends', () => {
  const now = Date.UTC(2026, 9, 16, 12);
  // Saturdays 9am UTC do great; weekday evenings do poorly.
  const sat = (weeksAgo) => Date.UTC(2026, 9, 10, 9) - weeksAgo * 7 * DAY;
  const wed = (weeksAgo) => Date.UTC(2026, 9, 7, 19) - weeksAgo * 7 * DAY;
  const videos = [
    ...[0, 1, 2].map((w) => ({ id: `s${w}`, createdAt: sat(w), title: 'Driveway #beforeandafter #pressurewashing', description: '', duration: 22, views: 50000, likes: 4000, comments: 200, shares: 300 })),
    ...[0, 1, 2, 3].map((w) => ({ id: `w${w}`, createdAt: wed(w), title: 'Tips #pressurewashing', description: '', duration: 95, views: 5000, likes: 150, comments: 10, shares: 5 })),
    { id: 'new', createdAt: now - DAY, title: 'Fresh one', description: '', duration: 20, views: 9000, likes: 900, comments: 50, shares: 40 },
  ];
  const snapshots = [
    { at: now - 8 * DAY, followers: 1000, views: { new: 0, s0: 40000 } },
    { at: now - 1 * DAY, followers: 1100, views: { new: 100, s0: 49000 } },
    { at: now, followers: 1180, views: { new: 9000, s0: 50000 } },
  ];
  const trending = [
    { name: '#cleantok', status: 'breakout', rank: 3 },
    { name: '#pressurewashing', status: 'rising', rank: 9 },
    { name: '#fyp', status: 'steady', rank: 1 },
  ];
  const a = analyze({ videos, snapshots, timeZone: 'UTC', trending, now });

  assert.equal(a.totals.videos, 8);
  assert.equal(a.enoughData, true);
  assert.equal(a.followers.change7d, 180);
  const text = a.insights.map((i) => i.text).join('\n');
  assert.match(text, /Saturdays 8am–12pm get/);
  assert.match(text, /#beforeandafter get/);
  assert.match(text, /15–30s videos do best/);
  assert.match(text, /taking off/);
  assert.deepEqual(a.trendingNew.map((t) => t.name), ['#cleantok']);
  assert.deepEqual(a.trendingUsed.map((t) => t.name), ['#pressurewashing']);
  assert.equal(a.videos.find((v) => v.id === 's0').label, 'hit');
  assert.equal(a.videos.find((v) => v.id === 's0').gained7d, 10000);
  assert.deepEqual(hashtagsOf('Hi #One #two #one'), ['one', 'two']);
});

test('analysis copes with no videos and an unknown time zone', () => {
  const a = analyze({ videos: [], timeZone: 'Not/AZone' });
  assert.equal(a.totals.videos, 0);
  assert.ok(a.insights.some((i) => /No public videos/.test(i.text)));
});

// ---------- the app in "Vercel" mode ----------

function fakeWorld({ username = 'washbros' } = {}) {
  const redis = fakeRedis();
  const calls = { emails: [], revoked: 0, refreshed: 0 };
  const fetchImpl = async (url, init = {}) => {
    if (redis.handles(url)) return redis.handle(init);
    if (url.startsWith('https://open.tiktokapis.com/v2/oauth/token/')) {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'refresh_token') calls.refreshed++;
      if (form.get('code') === 'bad') return Response.json({ error: 'invalid_grant', error_description: 'Code expired' }, { status: 400 });
      return Response.json({ access_token: 'act.1', refresh_token: 'rft.1', open_id: 'oid-1', expires_in: 86400, refresh_expires_in: 31536000, scope: 'user.info.basic,video.list' });
    }
    if (url.startsWith('https://open.tiktokapis.com/v2/oauth/revoke/')) {
      calls.revoked++;
      return Response.json({});
    }
    if (url.startsWith('https://open.tiktokapis.com/v2/user/info/')) {
      assert.equal(init.headers.authorization, 'Bearer act.1');
      return Response.json({ data: { user: { open_id: 'oid-1', username, display_name: 'Wash Bros', follower_count: 1200, likes_count: 50000, video_count: 2 } }, error: { code: 'ok' } });
    }
    if (url.startsWith('https://open.tiktokapis.com/v2/video/list/')) {
      return Response.json({
        data: {
          videos: [
            { id: 'v1', create_time: Math.floor((Date.now() - 10 * DAY) / 1000), title: 'Deck #beforeandafter', duration: 25, view_count: 12000, like_count: 900, comment_count: 40, share_count: 30, share_url: 'https://www.tiktok.com/@washbros/video/v1' },
            { id: 'v2', create_time: Math.floor((Date.now() - 5 * DAY) / 1000), title: 'Roof', duration: 70, view_count: 3000, like_count: 100, comment_count: 4, share_count: 2 },
          ],
          has_more: false,
          cursor: 0,
        },
        error: { code: 'ok' },
      });
    }
    if (url === 'https://api.resend.com/emails') {
      calls.emails.push(JSON.parse(init.body));
      return Response.json({ id: 'e1' });
    }
    if (url.includes('GetHashtagList')) return ccList([ccItem('cleantok', 1, [10, 50, 90])]);
    return new Response('unexpected', { status: 404 });
  };
  return { redis, calls, fetchImpl };
}

async function withCloud(env, world, fn) {
  const server = createApp({
    env: { VERCEL: '1', KV_REST_API_URL: world.redis.url, KV_REST_API_TOKEN: 't', ...env },
    fetchImpl: world.fetchImpl,
    delayMs: 0,
    notify: () => {},
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookies = {};
  const call = async (path, init = {}) => {
    const res = await fetch(base + path, {
      redirect: 'manual',
      ...init,
      headers: { ...(init.headers ?? {}), cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v) cookies[k] = v;
      else delete cookies[k];
    }
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, location: res.headers.get('location') };
  };
  try {
    await fn(call, { resetCookies: () => (cookies = {}) });
  } finally {
    server.close();
  }
}

test('cloud: setup errors are explained', async () => {
  const world = fakeWorld();
  await withCloud({}, world, async (call) => {
    const me = await call('/api/me');
    assert.match(me.body.setupError, /SESSION_SECRET/);
    assert.equal((await call('/api/trends')).status, 503);
  });
  await withCloud({ SESSION_SECRET: SECRET }, world, async (call) => {
    assert.match((await call('/api/me')).body.setupError, /No way to log in/);
  });
});

test('cloud: password login gates the API; Vercel rewrite path works', async () => {
  const world = fakeWorld();
  await withCloud({ SESSION_SECRET: SECRET, APP_PASSWORD: 'open sesame' }, world, async (call) => {
    const me = await call('/api/me');
    assert.equal(me.body.loggedIn, false);
    assert.equal(me.body.storage, 'redis');
    assert.equal((await call('/api/trends')).status, 401);
    assert.equal((await call('/api/watchlist')).status, 401);

    const wrong = await call('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"nope"}' });
    assert.equal(wrong.status, 401);
    const ok = await call('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"open sesame"}' });
    assert.equal(ok.status, 200);

    assert.equal((await call('/api/me')).body.loggedIn, true);
    assert.equal((await call('/api/main?__path=trends&kind=hashtags')).body.kind, 'hashtags');
    assert.equal((await call('/api/account')).body.configured, false);

    await call('/api/auth/logout', { method: 'POST' });
    assert.equal((await call('/api/trends')).status, 401);
  });
});

test('cloud: cron needs the secret, runs alerts and emails the weekly report', async () => {
  const world = fakeWorld();
  const env = {
    SESSION_SECRET: SECRET, APP_PASSWORD: 'pw', CRON_SECRET: 'cron-secret',
    TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs', TIKTOK_USERNAME: 'washbros',
    RESEND_API_KEY: 're_test', ALERT_EMAIL: 'me@example.com',
  };
  await withCloud(env, world, async (call) => {
    assert.equal((await call('/api/cron')).status, 401);
    assert.equal((await call('/api/cron', { headers: { authorization: 'Bearer wrong' } })).status, 401);

    // Connect TikTok, then add a keyword so the cron run raises an alert.
    const start = await call('/api/auth/tiktok');
    const state = new URL(start.location).searchParams.get('state');
    await call(`/api/auth/tiktok/callback?code=good&state=${state}`);
    await call('/api/alerts/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"keywords":["cleantok"]}' });

    const run = await call('/api/cron', { headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(run.status, 200);
    assert.equal(run.body.alerts.alerts, 1);
    assert.equal(run.body.report, 'sent');
    const subjects = world.calls.emails.map((e) => e.subject);
    assert.ok(subjects.includes('Trend alert: #cleantok'), subjects.join('; '));
    assert.ok(subjects.some((s) => /Your TikTok week/.test(s)), subjects.join('; '));
    assert.deepEqual(world.calls.emails[0].to, ['me@example.com']);

    // The report only goes out weekly.
    const again = await call('/api/cron', { headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(again.body.report, undefined);
  });
});

test('cloud: TikTok login connects the owner account and analyzes it', async () => {
  const world = fakeWorld();
  const env = { SESSION_SECRET: SECRET, TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs', TIKTOK_USERNAME: '@WashBros', APP_URL: 'https://trendtok.example.com' };
  await withCloud(env, world, async (call) => {
    const start = await call('/api/auth/tiktok');
    assert.equal(start.status, 302);
    const auth = new URL(start.location);
    assert.equal(auth.origin + auth.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://trendtok.example.com/api/auth/tiktok/callback');
    assert.match(auth.searchParams.get('scope'), /video\.list/);

    const forged = await call('/api/auth/tiktok/callback?code=good&state=forged');
    assert.match(decodeURIComponent(forged.location), /tampered/);

    const again = await call('/api/auth/tiktok');
    const state = new URL(again.location).searchParams.get('state');
    const cb = await call(`/api/auth/tiktok/callback?code=good&state=${state}`);
    assert.equal(cb.location, '/#account');

    const acct = await call('/api/account?tz=America/Chicago');
    assert.equal(acct.body.connected, true);
    assert.equal(acct.body.profile.username, 'washbros');
    assert.equal(acct.body.profile.tokens, undefined, 'tokens never leave the server');
    assert.equal(acct.body.analysis.videos.length, 2);
    assert.equal(acct.body.analysis.videos[0].id, 'v2', 'newest first');

    // Tokens are stored encrypted.
    const raw = world.redis.data.get('trendtok:tiktok-account.json');
    assert.doesNotMatch(raw, /act\.1|rft\.1/);

    // An expired access token is refreshed on the next sync.
    const doc = JSON.parse(raw);
    doc.tokens.expiresAt = 0;
    world.redis.data.set('trendtok:tiktok-account.json', JSON.stringify(doc));
    assert.equal((await call('/api/account/sync', { method: 'POST' })).status, 200);
    assert.equal(world.calls.refreshed, 1);

    const off = await call('/api/account/disconnect', { method: 'POST' });
    assert.equal(off.body.connected, false);
    assert.equal(world.calls.revoked, 1);
    assert.equal((await call('/api/trends')).status, 401, 'TikTok session ends on disconnect');
  });
});

test('cloud: other TikTok accounts are turned away', async () => {
  const world = fakeWorld({ username: 'someoneelse' });
  const env = { SESSION_SECRET: SECRET, TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs', TIKTOK_USERNAME: 'washbros' };
  await withCloud(env, world, async (call) => {
    const start = await call('/api/auth/tiktok');
    const state = new URL(start.location).searchParams.get('state');
    const cb = await call(`/api/auth/tiktok/callback?code=good&state=${state}`);
    assert.match(decodeURIComponent(cb.location), /@someoneelse isn't allowed/);
    assert.equal(world.calls.revoked, 1);
    assert.equal(world.redis.data.get('trendtok:tiktok-account.json'), undefined);
    assert.equal((await call('/api/me')).body.loggedIn, false);
  });
  await withCloud({ SESSION_SECRET: SECRET, TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs' }, world, async (call) => {
    const start = await call('/api/auth/tiktok');
    assert.match(decodeURIComponent(start.location), /Set TIKTOK_USERNAME/);
  });
});
