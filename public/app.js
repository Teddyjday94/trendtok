const $ = (sel) => document.querySelector(sel);

const COUNTRIES = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand',
  IE: 'Ireland', DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain', NL: 'Netherlands',
  BE: 'Belgium', SE: 'Sweden', PL: 'Poland', PT: 'Portugal', TR: 'Türkiye', BR: 'Brazil',
  MX: 'Mexico', AR: 'Argentina', CO: 'Colombia', CL: 'Chile', PE: 'Peru', JP: 'Japan',
  KR: 'South Korea', TW: 'Taiwan', ID: 'Indonesia', PH: 'Philippines', VN: 'Vietnam',
  TH: 'Thailand', MY: 'Malaysia', SG: 'Singapore', SA: 'Saudi Arabia', AE: 'United Arab Emirates',
  EG: 'Egypt', ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya', IL: 'Israel', PK: 'Pakistan',
};

const prefs = (() => {
  const defaults = { tab: 'hashtags', country: 'US', period: 7, sort: 'rank' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('trendtok-prefs') || '{}') };
  } catch {
    return defaults;
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem('trendtok-prefs', JSON.stringify(prefs));
  } catch {}
};

const LIST_TABS = ['hashtags', 'sounds', 'creators', 'videos'];
const state = {
  data: null,
  watchlist: [],
  loading: false,
  requestId: 0,
  lookup: null, // { name, loading, result, error }
  alerts: null, // { settings, events, unread, running, offline }
  checking: false,
};

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function compact(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
const watchKey = (kind, id) => `${kind}:${id}`;
const isWatched = (item) => state.watchlist.some((w) => watchKey(w.kind, w.id) === watchKey(item.kind, item.id));

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    showGate();
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function sparkline(trend, w = 110, h = 34, cls = 'spark') {
  if (!trend?.length) return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const vs = trend.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const pts = vs.map((v, i) => [
    (i / Math.max(1, vs.length - 1)) * (w - 4) + 2,
    h - 3 - ((v - min) / span) * (h - 6),
  ]);
  const line = pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
  const rising = vs.at(-1) >= vs[0];
  const color = rising ? 'var(--cyan)' : 'var(--pink)';
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="2,${h} ${line} ${w - 2},${h}" fill="${color}" opacity=".12"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function bigChart(trend, yFormat = (v, max) => Math.round((v / max) * 100), w = 480) {
  const h = 180;
  const pad = { l: 34, r: 10, t: 12, b: 24 };
  if (!trend?.length) return '<p class="note">No trend curve for this item.</p>';
  const vs = trend.map((p) => p.v);
  const max = Math.max(...vs) || 1;
  const x = (i) => pad.l + (i / Math.max(1, vs.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const line = vs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const fmt = (t) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
  const grid = [0, 0.5, 1]
    .map((f) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="var(--line)"/>
      <text x="${pad.l - 6}" y="${y(max * f) + 4}" text-anchor="end">${esc(yFormat(max * f, max))}</text>`)
    .join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Popularity over time">
    ${grid}
    <polygon points="${pad.l},${y(0)} ${line} ${x(vs.length - 1)},${y(0)}" fill="var(--cyan)" opacity=".12"/>
    <polyline points="${line}" fill="none" stroke="var(--cyan)" stroke-width="2.5" stroke-linejoin="round"/>
    <text x="${pad.l}" y="${h - 6}">${fmt(trend[0].t)}</text>
    <text x="${w - pad.r}" y="${h - 6}" text-anchor="end">${fmt(trend.at(-1).t)}</text>
  </svg>`;
}

function rankChart(seen) {
  const w = 480;
  const h = 140;
  const pad = { l: 34, r: 10, t: 12, b: 24 };
  const ranks = seen.map((s) => s.rank);
  const worst = Math.max(...ranks);
  const best = Math.min(...ranks);
  const span = worst - best || 1;
  const x = (i) => pad.l + (i / Math.max(1, seen.length - 1)) * (w - pad.l - pad.r);
  const y = (r) => pad.t + ((r - best) / span) * (h - pad.t - pad.b);
  const line = seen.map((s, i) => `${x(i).toFixed(1)},${y(s.rank).toFixed(1)}`).join(' ');
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Rank each time you checked">
    <text x="${pad.l - 6}" y="${y(best) + 4}" text-anchor="end">#${best}</text>
    <text x="${pad.l - 6}" y="${y(worst) + 4}" text-anchor="end">#${worst}</text>
    <polyline points="${line}" fill="none" stroke="var(--pink)" stroke-width="2.5" stroke-linejoin="round"/>
    ${seen.map((s, i) => `<circle cx="${x(i)}" cy="${y(s.rank)}" r="3" fill="var(--pink)"/>`).join('')}
    <text x="${pad.l}" y="${h - 6}">${fmt(seen[0].at)}</text>
    <text x="${w - pad.r}" y="${h - 6}" text-anchor="end">${fmt(seen.at(-1).at)}</text>
  </svg>`;
}

function moveLabel(item) {
  if (item.isNew) return '<span class="move new">NEW</span>';
  if (item.rankChange > 0) return `<span class="move up">▲ ${item.rankChange}</span>`;
  if (item.rankChange < 0) return `<span class="move down">▼ ${-item.rankChange}</span>`;
  return '<span class="move same">–</span>';
}

function thumb(item) {
  const initial = esc((item.name || '?').replace(/^#/, '').charAt(0).toUpperCase());
  if (!item.cover) return `<div class="thumb">${initial}</div>`;
  return `<div class="thumb">${initial}<img src="${esc(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></div>`;
}

function primaryMetric(item) {
  if (item.kind === 'hashtags') return `<b>${compact(item.views)}</b>views · ${compact(item.posts)} posts`;
  if (item.kind === 'creators') return `<b>${compact(item.followers)}</b>followers`;
  if (item.duration) return `<b>${item.duration}s</b>length`;
  return '';
}
const sortValue = (item) => item.views ?? item.followers ?? item.posts ?? 0;

// ---------- rendering ----------
function visibleItems() {
  const items = state.data?.items ?? [];
  const q = $('#search').value.trim().toLowerCase();
  const niche = $('#niche').value;
  const rising = $('#rising').checked;
  const list = items.filter(
    (x) =>
      (!q || `${x.name} ${x.subtitle ?? ''}`.toLowerCase().includes(q)) &&
      (!niche || x.industry === niche) &&
      (!rising || x.status === 'breakout' || x.status === 'rising' || x.isNew),
  );
  const by = {
    rank: (a, b) => a.rank - b.rank,
    momentum: (a, b) => b.momentum - a.momentum,
    views: (a, b) => sortValue(b) - sortValue(a),
    change: (a, b) => (b.isNew ? 999 : b.rankChange) - (a.isNew ? 999 : a.rankChange),
  }[prefs.sort];
  return list.sort(by);
}

// Same matching rule as the server: ignore case, spaces, # and _ or -.
const squash = (s) => String(s ?? '').toLowerCase().replace(/[#\s_-]+/g, '');
function matchedKeyword(item) {
  const text = squash(`${item.name} ${item.subtitle ?? ''}`);
  return (state.alerts?.settings.keywords ?? []).find((k) => squash(k) && text.includes(squash(k))) ?? null;
}

function rowHtml(item, i) {
  const watched = isWatched(item);
  const keyword = matchedKeyword(item);
  return `<div class="row${keyword ? ' match' : ''}" role="button" tabindex="0" data-i="${i}"${keyword ? ` title="Matches your alert keyword “${esc(keyword)}”"` : ''}>
    <div class="rank">${item.rank}${moveLabel(item)}</div>
    ${thumb(item)}
    <div style="min-width:0"><div class="name">${esc(item.name)}</div><div class="sub">${esc(item.subtitle ?? '')}${item.promoted ? ' · promoted' : ''}</div></div>
    <div class="metric">${primaryMetric(item)}</div>
    ${sparkline(item.trend)}
    <span class="pill ${item.status}" title="Momentum ${item.momentum}/100">${item.status}</span>
    <button class="star ${watched ? 'on' : ''}" data-star="${i}" type="button"
      aria-label="${watched ? 'Remove from' : 'Add to'} watchlist" aria-pressed="${watched}">${watched ? '★' : '☆'}</button>
  </div>`;
}

let rendered = [];
function render() {
  const tab = prefs.tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('#watch-count').textContent = state.watchlist.length || '';
  $('#alert-count').textContent = state.alerts?.unread || '';
  const listTab = LIST_TABS.includes(tab);
  $('#refresh').hidden = !listTab && tab !== 'lookup';
  $('#controls').hidden = !listTab && tab !== 'lookup';
  $('#lookup-form').hidden = tab !== 'lookup';
  document.querySelectorAll('.list-only').forEach((el) => (el.hidden = !listTab));
  $('#niche-wrap').hidden = tab !== 'hashtags';
  if (!listTab) $('#source').hidden = true;
  document.querySelectorAll('#period button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.period) === prefs.period)));

  if (tab === 'watchlist') return renderWatchlist();
  if (tab === 'lookup') return renderLookup();
  if (tab === 'alerts') return renderAlerts();
  if (tab === 'account') return renderAccount();

  const list = $('#list');
  if (state.loading && !state.data) {
    $('#summary').innerHTML = '';
    list.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
    return;
  }
  const d = state.data;
  if (!d) return;

  const src = $('#source');
  src.hidden = false;
  src.className = `badge ${d.source === 'sample' ? 'sample' : 'live'}`;
  const ago = Math.round((Date.now() - d.fetchedAt) / 60000);
  src.textContent = d.source === 'sample' ? 'Sample data' : `Live · ${ago < 1 ? 'just now' : `${ago} min ago`}`;
  $('#warning').hidden = !d.warning;
  $('#warning').textContent = d.warning ?? '';

  const count = (s) => d.items.filter((x) => x.status === s).length;
  $('#summary').innerHTML = [
    [d.items.length, `${tab} tracked`],
    [count('breakout'), 'breakout'],
    [count('rising'), 'rising'],
    [d.items.filter((x) => x.isNew).length, 'new this period'],
  ]
    .map(([n, label]) => `<div class="stat"><b>${n}</b><span>${esc(label)}</span></div>`)
    .join('');

  rendered = visibleItems();
  list.innerHTML = rendered.length
    ? rendered.map(rowHtml).join('')
    : '<div class="empty">Nothing matches these filters.</div>';
}

function renderWatchlist() {
  $('#summary').innerHTML = '';
  $('#warning').hidden = true;
  rendered = state.watchlist.map((w) => ({ ...w, trend: [], status: 'steady', rank: '★', rankChange: 0 }));
  $('#list').innerHTML = rendered.length
    ? rendered
        .map(
          (w, i) => `<div class="row" role="button" tabindex="0" data-i="${i}">
      <div class="rank" style="font-size:13px;color:var(--muted)">${esc(w.kind)}</div>
      ${thumb(w)}
      <div style="min-width:0"><div class="name">${esc(w.name)}</div><div class="sub">${esc(w.note || w.subtitle || '')}</div></div>
      <div class="metric">Added ${new Date(w.addedAt).toLocaleDateString()}</div>
      <span></span>
      ${w.url ? `<a class="btn" href="${esc(w.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open</a>` : '<span></span>'}
      <button class="star on" data-star="${i}" type="button" aria-label="Remove from watchlist">★</button>
    </div>`,
        )
        .join('')
    : '<div class="empty">Star a hashtag, sound, creator or video to keep an eye on it here.</div>';
}

function openDrawer(item) {
  const watched = isWatched(item);
  const live = state.data?.items.find((x) => x.kind === item.kind && x.id === item.id) ?? item;
  const stats = [
    ['Rank', live.rank != null && live.rank !== '★' ? `#${live.rank}` : '—'],
    ['Momentum', live.momentum != null ? `${live.momentum}/100 · ${live.status}` : '—'],
    live.views != null && ['Views', compact(live.views)],
    live.posts != null && ['Posts', compact(live.posts)],
    live.followers != null && ['Followers', compact(live.followers)],
    live.likes != null && ['Likes', compact(live.likes)],
    live.industry && ['Niche', live.industry],
    live.duration && ['Length', `${live.duration}s`],
  ].filter(Boolean);
  const existing = state.watchlist.find((w) => watchKey(w.kind, w.id) === watchKey(item.kind, item.id));

  $('#d-body').innerHTML = `
    <h2 id="d-title">${esc(live.name)}</h2>
    <div class="sub">${esc(live.subtitle ?? '')}</div>
    <div class="kv">${stats.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b style="font-size:17px">${esc(v)}</b></div>`).join('')}</div>
    ${live.trend?.length ? `<h3>Popularity</h3>${bigChart(live.trend)}` : ''}
    ${live.seen?.length > 1 ? `<h3>Your rank history</h3>${rankChart(live.seen)}<p class="note">Recorded each time you loaded live data (at most hourly).</p>` : ''}
    <h3>Watchlist</h3>
    <textarea id="d-note" placeholder="Notes: video idea, when to post…">${esc(existing?.note ?? '')}</textarea>
    <div class="actions">
      <button class="btn primary" id="d-watch" type="button">${watched ? 'Save note' : 'Add to watchlist'}</button>
      ${watched ? '<button class="btn" id="d-unwatch" type="button">Remove</button>' : ''}
      ${live.kind === 'hashtags' ? `<button class="btn" type="button" id="d-lookup">Full details</button>` : ''}
      ${live.url ? `<a class="btn" href="${esc(live.url)}" target="_blank" rel="noopener">Open on TikTok ↗</a>` : ''}
    </div>`;
  if (live.kind === 'hashtags') {
    $('#d-lookup').onclick = () => {
      closeDrawer();
      lookup(live.name);
    };
  }
  $('#drawer').hidden = false;
  $('#d-close').focus();
  $('#d-watch').onclick = async () => {
    await addWatch(live, $('#d-note').value);
    openDrawer(live);
  };
  if (watched) {
    $('#d-unwatch').onclick = async () => {
      await removeWatch(live);
      openDrawer(live);
    };
  }
}
const closeDrawer = () => {
  $('#drawer').hidden = true;
};

// ---------- data ----------
async function load({ refresh = false } = {}) {
  if (prefs.tab === 'lookup') return state.lookup?.name ? lookup(state.lookup.name, { refresh }) : render();
  if (prefs.tab === 'account') return loadAccount({ sync: refresh });
  if (!LIST_TABS.includes(prefs.tab)) return render();
  const id = ++state.requestId;
  state.loading = true;
  if (refresh || state.data?.kind !== prefs.tab) state.data = null;
  render();
  try {
    const qs = new URLSearchParams({ kind: prefs.tab, country: prefs.country, period: prefs.period });
    if (refresh) qs.set('refresh', '1');
    const data = await api(`/api/trends?${qs}`);
    if (id !== state.requestId) return;
    state.data = data;
    const niches = [...new Set(data.items.map((x) => x.industry).filter(Boolean))].sort();
    const current = $('#niche').value;
    $('#niche').innerHTML = '<option value="">All niches</option>' + niches.map((n) => `<option>${esc(n)}</option>`).join('');
    $('#niche').value = niches.includes(current) ? current : '';
  } catch (err) {
    if (id !== state.requestId) return;
    $('#list').innerHTML = `<div class="empty">Couldn't load trends: ${esc(err.message)}</div>`;
    return;
  } finally {
    if (id === state.requestId) state.loading = false;
  }
  render();
}

async function addWatch(item, note = '') {
  state.watchlist = await api('/api/watchlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: item.kind, id: item.id, name: item.name, subtitle: item.subtitle, url: item.url, note }),
  });
  render();
}
async function removeWatch(item) {
  const qs = new URLSearchParams({ kind: item.kind, id: item.id });
  state.watchlist = await api(`/api/watchlist?${qs}`, { method: 'DELETE' });
  render();
}


// ---------- lookup ----------
const LOOKUP_EXAMPLES = ['pressurewashing', 'beforeandafter', 'cleantok', 'satisfying', 'smallbusiness'];
const cleanTag = (s) => String(s ?? '').trim().replace(/^#+/, '').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');

function bars(list) {
  if (!list?.length) return '<p class="note">No data.</p>';
  return list
    .map(
      (x) => `<div class="bar"><span>${esc(x.label)}</span>
        <div class="bar-track"><i style="width:${Math.max(2, Math.min(100, x.share))}%"></i></div><b>${x.share}%</b></div>`,
    )
    .join('');
}

const keywords = () => state.alerts?.settings.keywords ?? [];
const hasKeyword = (name) => keywords().some((k) => squash(k) === squash(name));

function renderLookup() {
  $('#summary').innerHTML = '';
  const L = state.lookup;
  const list = $('#list');
  $('#warning').hidden = true;
  if (!L) {
    const ideas = [...new Set([...keywords().map(cleanTag).filter(Boolean), ...LOOKUP_EXAMPLES])].slice(0, 10);
    list.innerHTML = `<div class="empty">Look up any hashtag, even one that's not on the top charts.
      <div class="chips center">${ideas.map((n) => `<button class="chip" type="button" data-action="lookup" data-name="${esc(n)}">#${esc(n)}</button>`).join('')}</div></div>`;
    return;
  }
  if (L.loading) {
    list.innerHTML = Array.from({ length: 3 }, () => '<div class="skeleton tall"></div>').join('');
    return;
  }
  if (L.error) {
    list.innerHTML = `<div class="empty">Couldn't look up #${esc(L.name)}: ${esc(L.error)}</div>`;
    return;
  }
  const r = L.result;
  const src = $('#source');
  src.hidden = false;
  src.className = `badge ${r.source === 'sample' ? 'sample' : 'live'}`;
  src.textContent = r.source === 'sample' ? 'Sample data' : 'Live';
  $('#warning').hidden = !r.warning;
  $('#warning').textContent = r.warning ?? '';
  const alertBtn = `<button class="btn" type="button" data-action="toggle-keyword" data-name="${esc(r.name)}">
    ${hasKeyword(r.name) ? '🔔 Alerting · remove' : '🔔 Alert me about this'}</button>`;

  if (r.notFound) {
    list.innerHTML = `<div class="empty"><p>${esc(r.message)}.</p>
      <p class="note">Creative Center only tracks hashtags with enough recent activity. Try another country or a longer period,
      or add it as an alert keyword so the daily check tells you when it shows up.</p>
      <div class="actions center">${alertBtn}</div></div>`;
    return;
  }

  const d = r.detail;
  const item = { ...d, kind: 'hashtags' };
  const watched = isWatched(item);
  const stats = [
    ['Chart rank', d.rank ? `#${d.rank}` : 'Not in top chart'],
    ['Momentum', `${d.momentum}/100`],
    ['Posts this period', compact(d.postsInPeriod ?? d.posts)],
    ['Views this period', compact(d.views)],
    d.postsTotal && ['Posts all time', compact(d.postsTotal)],
    d.viewsTotal && ['Views all time', compact(d.viewsTotal)],
  ].filter(Boolean);
  const series = (r.series ?? []).filter((p) => p.views != null);
  // Draw charts at the panel's real width so they fill it without stretching the text.
  const chartW = Math.max(280, Math.min(1000, $('#list').clientWidth - 38));

  list.innerHTML = `<article class="panel lookup">
    <div class="lookup-head">
      <div><h2>${esc(d.name)}</h2><div class="sub">${esc(d.industry ?? '')}</div></div>
      <span class="pill ${d.status}">${d.status}</span>
    </div>
    <div class="kv three">${stats.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <h3>Popularity · last ${r.period} days</h3>
    ${bigChart(d.trend, undefined, chartW)}
    ${series.length > 1
      ? `<h3>Views over time · your checks</h3>${bigChart(series.map((p) => ({ t: p.at / 1000, v: p.views })), (v) => compact(v), chartW)}`
      : '<p class="note">Each time you look this up (or the daily check does), the numbers are saved, so a chart of your own builds up here.</p>'}
    <div class="cols">
      <div><h3>Audience age</h3>${bars(d.audienceAges)}</div>
      <div><h3>Top countries</h3>${bars(d.audienceCountries)}</div>
      ${d.audienceInterests?.length ? `<div><h3>Interests</h3>${bars(d.audienceInterests)}</div>` : ''}
    </div>
    ${d.related?.length ? `<h3>Related hashtags</h3><div class="chips">${d.related
      .map((n) => `<button class="chip" type="button" data-action="lookup" data-name="${esc(n)}">#${esc(n)}</button>`)
      .join('')}</div>` : ''}
    <div class="actions">
      <button class="btn primary" type="button" data-action="toggle-watch">${watched ? '★ Watching · remove' : '☆ Add to watchlist'}</button>
      ${alertBtn}
      <button class="btn" type="button" data-action="refresh-lookup">Refresh</button>
      ${d.url ? `<a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">Open on TikTok ↗</a>` : ''}
    </div>
  </article>`;
}

async function lookup(raw, { refresh = false } = {}) {
  const name = cleanTag(raw);
  if (!name) return;
  prefs.tab = 'lookup';
  prefs.lookup = name;
  savePrefs();
  $('#lookup-input').value = `#${name}`;
  const id = ++state.requestId;
  state.lookup = { name, loading: true };
  render();
  try {
    const qs = new URLSearchParams({ name, country: prefs.country, period: prefs.period });
    if (refresh) qs.set('refresh', '1');
    const result = await api(`/api/lookup?${qs}`);
    if (id !== state.requestId) return;
    state.lookup = { name, result };
  } catch (err) {
    if (id !== state.requestId) return;
    state.lookup = { name, error: err.message };
  }
  render();
}

// ---------- alerts ----------
const timeAgo = (at) => {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

let knownEvents = null;
async function refreshAlerts() {
  let next;
  try {
    next = await api('/api/alerts');
  } catch {
    return;
  }
  applyAlerts(next);
}

function applyAlerts(next) {
  // Browser notification for alerts that arrived since the last poll.
  if (knownEvents) {
    const fresh = next.events.filter((e) => !knownEvents.has(e.id) && !e.read);
    if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
      const first = fresh[0];
      new Notification(fresh.length === 1 ? `Trend alert: ${first.name}` : `${fresh.length} new trend alerts`, {
        body: fresh.slice(0, 3).map((e) => `${e.name} ${e.reason}`).join('\n'),
        icon: 'favicon.svg',
      });
    }
  }
  knownEvents = new Set(next.events.map((e) => e.id));
  // While a check runs on the server, poll quickly so the result shows up promptly.
  clearTimeout(applyAlerts.poll);
  if (next.running) applyAlerts.poll = setTimeout(refreshAlerts, 3000);
  const changed = JSON.stringify(next) !== JSON.stringify(state.alerts);
  state.alerts = next;
  if (changed) render();
}

async function saveAlertSettings(patch) {
  try {
    applyAlerts(await api('/api/alerts/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }));
  } catch (err) {
    alert(err.message);
  }
}

async function toggleKeyword(name) {
  const tag = cleanTag(name);
  const current = keywords();
  const next = hasKeyword(tag) ? current.filter((k) => squash(k) !== squash(tag)) : [...current, tag];
  await saveAlertSettings({ keywords: next });
}

function renderAlerts() {
  $('#summary').innerHTML = '';
  $('#warning').hidden = true;
  const list = $('#list');
  const A = state.alerts;
  if (!A) {
    list.innerHTML = '<div class="skeleton tall"></div>';
    return;
  }
  const s = A.settings;
  const draft = $('#kw-input')?.value ?? '';
  const requests = s.countries.length * (4 + s.keywords.length);
  const last = s.lastResult;
  const canNotify = 'Notification' in window;

  list.innerHTML = `
  <section class="panel">
    <h3>Keywords</h3>
    <div class="chips">${s.keywords.length
      ? s.keywords.map((k) => `<span class="chip on">${esc(k)}<button type="button" data-action="rm-keyword" data-k="${esc(k)}" aria-label="Remove ${esc(k)}">×</button></span>`).join('')
      : '<span class="note">No keywords yet. Try “pressure washing”, “cleantok” or “before and after”.</span>'}</div>
    <form id="kw-form" class="inline-form">
      <input id="kw-input" type="text" maxlength="50" placeholder="Add a keyword or #hashtag" autocomplete="off">
      <button class="btn primary" type="submit">Add</button>
    </form>
    <p class="note">You get an alert when a hashtag, sound, creator or video containing a keyword shows up on a chart, or turns Breakout.
      Case, spaces and # don't matter. Each keyword is also looked up as a hashtag, so you hear when it turns Breakout even if it's not in the top chart.</p>
  </section>

  <section class="panel">
    <h3>Daily collection</h3>
    <div class="settings">
      <label>Countries
        <span class="chips">${s.countries.map((c) => `<span class="chip on">${esc(COUNTRIES[c] ?? c)}${s.countries.length > 1 ? `<button type="button" data-action="rm-country" data-c="${c}" aria-label="Remove ${esc(c)}">×</button>` : ''}</span>`).join('')}
        ${s.countries.length < 3 ? `<select id="country-add"><option value="">+ add (max 3)</option>${Object.entries(COUNTRIES).filter(([c]) => !s.countries.includes(c)).map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('')}</select>` : ''}</span>
      </label>
      ${A.cloud
        ? '<p class="note">Checks run once a day, at about 8am US Central, using a Vercel cron job.</p>'
        : `<label>Check every
        <select id="interval">${[6, 12, 24, 48].map((h) => `<option value="${h}" ${h === s.intervalHours ? 'selected' : ''}>${h} hours</option>`).join('')}</select>
      </label>`}
      ${A.cloud && !A.email
        ? '<p class="note">Email alerts aren\'t set up. Add RESEND_API_KEY and ALERT_EMAIL in Vercel to get them.</p>'
        : `<label class="check"><input id="desktop" type="checkbox" ${s.desktop ? 'checked' : ''}> ${A.cloud
          ? `Email alerts to ${esc(A.email)}`
          : `Desktop notifications (works with the browser closed)${A.email ? ` and email to ${esc(A.email)}` : ''}`}</label>`}
      ${canNotify && Notification.permission !== 'granted'
        ? `<button class="btn" type="button" data-action="notify-perm">Also notify me in this browser</button>`
        : ''}
    </div>
    <p class="note">${s.lastRun ? `Last check ${timeAgo(s.lastRun)}: ${last.charts} chart${last.charts === 1 ? '' : 's'} collected, ${last.alerts} new alert${last.alerts === 1 ? '' : 's'}.` : 'No check has run yet.'}
      ${A.cloud ? '' : 'The server checks while it\'s running; leave <code>npm start</code> open (or run it at login) to keep collecting.'}</p>
    ${last?.errors?.length ? `<details class="note"><summary>${last.errors.length} part${last.errors.length === 1 ? '' : 's'} couldn't be fetched</summary><ul>${last.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
    <div class="actions">
      ${A.offline
        ? '<span class="note">Checks are off in offline mode.</span>'
        : `<button class="btn primary" type="button" data-action="check-now" ${state.checking || A.running ? 'disabled' : ''}>
            ${state.checking || A.running ? `Checking… (about ${Math.ceil((requests * 3) / 10) * 10} s)` : 'Check now'}</button>`}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h3>Alerts</h3>
      ${A.events.length ? `<div class="actions tight">
        ${A.unread ? '<button class="btn" type="button" data-action="mark-read">Mark all read</button>' : ''}
        <button class="btn" type="button" data-action="clear-events">Clear</button></div>` : ''}
    </div>
    ${A.events.length
      ? A.events.map((e) => `<div class="event${e.read ? '' : ' unread'}">
          <div><b>${esc(e.name)}</b> ${esc(e.reason)}
            <div class="sub">“${esc(e.keyword)}” · ${timeAgo(e.at)}${e.momentum != null ? ` · momentum ${e.momentum}` : ''}</div></div>
          <div class="actions tight">
            ${e.kind === 'hashtags' ? `<button class="btn" type="button" data-action="lookup" data-name="${esc(e.name)}">Details</button>` : ''}
            ${e.url ? `<a class="btn" href="${esc(e.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
          </div></div>`).join('')
      : '<p class="note">No alerts yet.</p>'}
  </section>`;
  $('#kw-input').value = draft;
}

async function handleAction(btn) {
  const a = btn.dataset.action;
  if (a === 'sync-account') return loadAccount({ sync: true });
  if (a === 'all-videos') {
    state.showAllVideos = true;
    return render();
  }
  if (a === 'disconnect') {
    if (!confirm('Disconnect your TikTok account? Saved snapshots are deleted too.')) return;
    await api('/api/account/disconnect', { method: 'POST' });
    state.account = null;
    if (state.me?.cloud) return location.reload();
    return loadAccount();
  }
  if (a === 'lookup') return lookup(btn.dataset.name);
  if (a === 'refresh-lookup') return lookup(state.lookup.name, { refresh: true });
  if (a === 'toggle-keyword') return toggleKeyword(btn.dataset.name);
  if (a === 'toggle-watch') {
    const item = { ...state.lookup.result.detail, kind: 'hashtags' };
    return isWatched(item) ? removeWatch(item) : addWatch(item);
  }
  if (a === 'rm-keyword') return saveAlertSettings({ keywords: keywords().filter((k) => k !== btn.dataset.k) });
  if (a === 'rm-country') return saveAlertSettings({ countries: state.alerts.settings.countries.filter((c) => c !== btn.dataset.c) });
  if (a === 'notify-perm') {
    await Notification.requestPermission();
    return render();
  }
  if (a === 'mark-read') return applyAlerts(await api('/api/alerts/read', { method: 'POST' }));
  if (a === 'clear-events') {
    if (!confirm('Clear all alerts?')) return;
    return applyAlerts(await api('/api/alerts/events', { method: 'DELETE' }));
  }
  if (a === 'check-now') {
    state.checking = true;
    render();
    try {
      applyAlerts(await api('/api/alerts/run', { method: 'POST' }));
    } catch (err) {
      alert(`Check failed: ${err.message}`);
    } finally {
      state.checking = false;
      render();
    }
  }
}


// ---------- my account ----------
const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BLOCK_NAMES = ['12–4am', '4–8am', '8am–12pm', '12–4pm', '4–8pm', '8pm–12am'];
const INSIGHT_ICONS = { hot: '🔥', time: '🕒', length: '⏱', tag: '#', engage: '💬', cadence: '📅', trend: '📈', info: 'ℹ️' };
const VIDEO_SORTS = {
  newest: ['Newest', (a, b) => b.createdAt - a.createdAt],
  views: ['Views', (a, b) => b.views - a.views],
  engagement: ['Engagement', (a, b) => b.engagement - a.engagement],
  perDay: ['Views / day', (a, b) => b.viewsPerDay - a.viewsPerDay],
  gained: ['Gained this week', (a, b) => (b.gained7d ?? -1) - (a.gained7d ?? -1)],
};
const signed = (n) => (n == null ? '' : `${n >= 0 ? '+' : '−'}${compact(Math.abs(n))}`);

async function loadAccount({ sync = false } = {}) {
  state.accountLoading = true;
  render();
  try {
    state.account = await api(`/api/account${sync ? '/sync' : ''}?tz=${encodeURIComponent(TZ)}`, sync ? { method: 'POST' } : undefined);
    state.accountError = null;
  } catch (err) {
    state.accountError = err.message;
  } finally {
    state.accountLoading = false;
  }
  render();
}

function heatmap(times) {
  const cell = new Map(times.map((t) => [`${t.day}:${t.block}`, t]));
  const max = Math.max(1.5, ...times.map((t) => t.performance));
  const rows = DAY_NAMES.map((d, day) => `<div class="hm-row"><span>${d}</span>${BLOCK_NAMES.map((_, block) => {
    const t = cell.get(`${day}:${block}`);
    if (!t) return '<i class="hm-cell blank"></i>';
    const alpha = Math.max(0.12, Math.min(1, t.performance / max));
    return `<i class="hm-cell" style="--a:${alpha.toFixed(2)}" title="${DAY_NAMES[day]} ${BLOCK_NAMES[block]}: ${t.count} video${t.count === 1 ? '' : 's'}, ${t.performance}× typical views">${t.count}</i>`;
  }).join('')}</div>`).join('');
  return `<div class="heatmap"><div class="hm-row hm-head"><span></span>${BLOCK_NAMES.map((b) => `<b>${b}</b>`).join('')}</div>${rows}</div>
    <p class="note">Numbers are how many videos you posted in that slot; brighter means more views than your typical video. Times are in ${esc(TZ)}.</p>`;
}

function perfBars(groups, labelFn) {
  if (!groups.length) return '<p class="note">Not enough videos yet.</p>';
  const max = Math.max(...groups.map((g) => g.performance), 1);
  return groups
    .map((g) => `<div class="bar"><span>${esc(labelFn(g))}</span>
      <div class="bar-track"><i style="width:${Math.max(3, (g.performance / max) * 100)}%"></i></div>
      <b title="${g.count} videos">${g.performance}×</b></div>`)
    .join('');
}

function renderAccount() {
  $('#summary').innerHTML = '';
  $('#warning').hidden = true;
  const list = $('#list');
  const A = state.account;
  if (state.accountLoading && !A) {
    list.innerHTML = '<div class="skeleton tall"></div><div class="skeleton tall"></div>';
    return;
  }
  if (state.accountError && !A) {
    list.innerHTML = `<div class="empty">Couldn't load your account: ${esc(state.accountError)}</div>`;
    return;
  }
  if (!A) return;
  if (!A.configured) {
    list.innerHTML = `<section class="panel connect">
      <h2>Connect your TikTok</h2>
      <p>TikTok login isn't set up yet. You need a free TikTok developer app; the README has step-by-step instructions
      (“Connect your TikTok account”). Then set <code>TIKTOK_CLIENT_KEY</code>, <code>TIKTOK_CLIENT_SECRET</code>
      and <code>TIKTOK_USERNAME</code>.</p></section>`;
    return;
  }
  if (!A.connected) {
    list.innerHTML = `<section class="panel connect">
      <h2>Connect your TikTok</h2>
      <p>Log in with TikTok to analyze your own videos: growth, engagement, your best posting times, what lengths and hashtags work for you,
      and which trends you haven't jumped on yet.</p>
      <p class="note">You approve on TikTok's own page; this app never sees your password. It only gets read access to your profile and public videos.</p>
      <div class="actions"><a class="btn primary" href="/api/auth/tiktok">Log in with TikTok</a></div></section>`;
    return;
  }

  const p = A.profile;
  const a = A.analysis;
  const sortKey = VIDEO_SORTS[prefs.videoSort] ? prefs.videoSort : 'newest';
  const vids = [...a.videos].sort(VIDEO_SORTS[sortKey][1]);
  const shown = state.showAllVideos ? vids : vids.slice(0, 15);
  const chartW = Math.max(280, Math.min(1000, list.clientWidth - 38));
  const stat = (label, value, change) =>
    `<div class="stat"><span>${esc(label)}</span><b>${esc(value)}</b>${change ? `<small class="${change.startsWith('−') ? 'down' : 'up'}">${esc(change)} this week</small>` : ''}</div>`;

  list.innerHTML = `
  ${p.needsReconnect || A.syncError ? `<div class="warning">${esc(A.syncError || 'TikTok sign-in expired.')}
    ${p.needsReconnect ? ' <a class="btn" href="/api/auth/tiktok">Reconnect</a>' : ''}</div>` : ''}
  <section class="panel">
    <div class="acct-head">
      ${p.avatarUrl ? `<img class="avatar" src="${esc(p.avatarUrl)}" alt="" referrerpolicy="no-referrer">` : '<div class="avatar"></div>'}
      <div class="acct-name"><h2>${esc(p.displayName)}${p.verified ? ' <span title="Verified">✔</span>' : ''}</h2>
        <div class="sub">${p.username ? `@${esc(p.username)}` : ''}${A.syncedAt ? ` · synced ${timeAgo(A.syncedAt)}` : ''}</div></div>
      <div class="actions tight">
        <button class="btn" type="button" data-action="sync-account" ${state.accountLoading ? 'disabled' : ''}>${state.accountLoading ? 'Syncing…' : 'Sync now'}</button>
        ${p.profileUrl ? `<a class="btn" href="${esc(p.profileUrl)}" target="_blank" rel="noopener">Profile ↗</a>` : ''}
      </div>
    </div>
    <div class="kv four">
      ${stat('Followers', compact(p.followers), signed(a.followers.change7d))}
      ${stat('Total likes', compact(p.likes))}
      ${stat('Typical views', compact(a.totals.typicalViews))}
      ${stat('Avg. engagement', `${a.totals.avgEngagement}%`)}
    </div>
  </section>

  <section class="panel">
    <h3>What the numbers say</h3>
    <ul class="insights">${a.insights.map((i) => `<li><span aria-hidden="true">${INSIGHT_ICONS[i.kind] ?? '•'}</span>${esc(i.text)}</li>`).join('')}</ul>
    ${A.trendingSource == null || A.trendingSource === 'sample' ? '<p class="note">Trend matching is off until live trend data loads.</p>' : ''}
  </section>

  ${a.trendingNew.length ? `<section class="panel"><h3>Trending now, not used by you yet</h3>
    <div class="chips">${a.trendingNew.map((t) => `<button class="chip" type="button" data-action="lookup" data-name="${esc(t.name)}">${esc(t.name)} <small class="pill-mini ${t.status}">${esc(t.status)}</small></button>`).join('')}</div></section>` : ''}

  <section class="panel">
    <h3>Followers</h3>
    ${a.followers.series.length > 1
      ? bigChart(a.followers.series.map((pt) => ({ t: pt.at / 1000, v: pt.v })), (v) => compact(v), chartW)
      : '<p class="note">A snapshot is saved every day, so this chart fills in over the next few days.</p>'}
  </section>

  <section class="panel">
    <h3>Best times to post</h3>
    ${a.times.length ? heatmap(a.times) : '<p class="note">Not enough videos older than 3 days yet.</p>'}
    <div class="cols">
      <div><h3>Video length</h3>${perfBars(a.lengths, (g) => g.label)}</div>
      <div><h3>Your hashtags</h3>${perfBars(a.tags.slice(0, 8), (g) => `#${g.key}`)}</div>
    </div>
    <p class="note">× means views compared with your typical video (${compact(a.totals.typicalViews)} views). Only videos 3+ days old are counted.</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h3>Your videos (${a.videos.length})</h3>
      <label class="note">Sort <select id="video-sort">${Object.entries(VIDEO_SORTS).map(([k, [label]]) => `<option value="${k}" ${k === sortKey ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    ${shown.map((v) => `<div class="vrow">
      <div class="thumb tall">${v.cover ? `<img src="${esc(v.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>
      <div class="vmain"><div class="name">${v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title || v.description || 'Untitled')}</a>` : esc(v.title || v.description || 'Untitled')}</div>
        <div class="sub">${new Date(v.createdAt).toLocaleDateString()} · ${v.duration}s${v.tags.length ? ` · ${v.tags.slice(0, 4).map((t) => `#${esc(t)}`).join(' ')}` : ''}</div></div>
      <div class="metric"><b>${compact(v.views)}</b>views${v.gained7d != null ? ` · +${compact(v.gained7d)} wk` : ''}</div>
      <div class="metric"><b>${v.engagement}%</b>engagement</div>
      <div>${v.label ? `<span class="pill ${v.label === 'hit' ? 'breakout' : 'cooling'}">${v.label === 'hit' ? `${v.performance}× hit` : 'low'}</span>` : `<span class="note">${v.performance}×</span>`}</div>
    </div>`).join('')}
    ${vids.length > shown.length ? `<div class="actions center"><button class="btn" type="button" data-action="all-videos">Show all ${vids.length}</button></div>` : ''}
  </section>

  <div class="actions"><button class="btn" type="button" data-action="disconnect">Disconnect TikTok</button></div>`;
}

// ---------- login gate ----------
function showGate(message) {
  const me = state.me ?? {};
  const gate = $('#gate');
  gate.hidden = false;
  $('#gate-error').hidden = !message;
  $('#gate-error').textContent = message ?? '';
  if (me.setupError) {
    $('#gate-body').innerHTML = `<p>Almost there. One setting is missing:</p><p class="note">${esc(me.setupError)}</p>`;
    return;
  }
  $('#gate-body').innerHTML = `
    ${me.login?.tiktok ? '<a class="btn primary wide" href="/api/auth/tiktok">Log in with TikTok</a>' : ''}
    ${me.login?.tiktok && me.login?.password ? '<p class="note or">or</p>' : ''}
    ${me.login?.password ? `<form id="pw-form" class="inline-form">
      <input id="pw" type="password" placeholder="App password" autocomplete="current-password" aria-label="App password" required>
      <button class="btn primary" type="submit">Log in</button></form>` : ''}`;
  $('#pw-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: $('#pw').value }),
      });
      location.reload();
    } catch (err) {
      showGate(err.message);
    }
  });
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const authError = params.get('auth_error');
  if (authError || location.hash === '#account') {
    if (location.hash === '#account') prefs.tab = 'account';
    history.replaceState(null, '', location.pathname);
  }
  try {
    state.me = await api('/api/me');
  } catch (err) {
    $('#list').innerHTML = `<div class="empty">Couldn't reach the server: ${esc(err.message)}</div>`;
    return;
  }
  const me = state.me;
  if (me.cloud) {
    $('#brand-sub').hidden = true;
    document.title = 'TrendTok';
  }
  if (me.setupError || !me.loggedIn) return showGate(authError);
  if (authError) {
    $('#warning').hidden = false;
    $('#warning').textContent = authError;
  }
  $('#logout').hidden = !me.cloud;
  if (me.cloud && me.storage === 'temporary') {
    console.warn('No database connected: data will be lost between deploys. Add Upstash Redis in Vercel → Storage.');
  }
  api('/api/watchlist')
    .then((w) => {
      state.watchlist = w;
      render();
    })
    .catch(() => {});
  if (prefs.tab === 'lookup' && prefs.lookup) state.lookup = { name: prefs.lookup };
  load();
  refreshAlerts();
  setInterval(refreshAlerts, 60_000);
}

// ---------- events ----------
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => (prefs.tab === 'lookup' || prefs.tab === 'account') && render(), 150);
});
$('#country').innerHTML = Object.entries(COUNTRIES)
  .map(([code, name]) => `<option value="${code}">${esc(name)}</option>`)
  .join('');
$('#country').value = prefs.country;
$('#sort').value = prefs.sort;

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  prefs.tab = b.dataset.tab;
  savePrefs();
  load();
});
$('#period').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-period]');
  if (!b) return;
  prefs.period = Number(b.dataset.period);
  savePrefs();
  load();
});
$('#country').addEventListener('change', (e) => {
  prefs.country = e.target.value;
  savePrefs();
  load();
});
$('#sort').addEventListener('change', (e) => {
  prefs.sort = e.target.value;
  savePrefs();
  render();
});
['#search', '#niche', '#rising'].forEach((s) => $(s).addEventListener('input', render));
$('#refresh').addEventListener('click', () => load({ refresh: true }));
$('#logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});
$('#lookup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  lookup($('#lookup-input').value);
});
$('#list').addEventListener('submit', (e) => {
  if (e.target.id !== 'kw-form') return;
  e.preventDefault();
  const value = $('#kw-input').value.trim();
  if (!value) return;
  $('#kw-input').value = '';
  saveAlertSettings({ keywords: [...keywords(), value] });
});
$('#list').addEventListener('change', (e) => {
  if (e.target.id === 'country-add' && e.target.value) {
    saveAlertSettings({ countries: [...state.alerts.settings.countries, e.target.value] });
  } else if (e.target.id === 'interval') {
    saveAlertSettings({ intervalHours: Number(e.target.value) });
  } else if (e.target.id === 'video-sort') {
    prefs.videoSort = e.target.value;
    savePrefs();
    render();
  } else if (e.target.id === 'desktop') {
    saveAlertSettings({ desktop: e.target.checked });
  }
});

$('#list').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]');
  if (action) return handleAction(action);
  const star = e.target.closest('[data-star]');
  if (star) {
    e.stopPropagation();
    const item = rendered[Number(star.dataset.star)];
    if (isWatched(item)) await removeWatch(item);
    else await addWatch(item);
    return;
  }
  const row = e.target.closest('.row');
  if (row) openDrawer(rendered[Number(row.dataset.i)]);
});
$('#list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('row')) {
    e.preventDefault();
    openDrawer(rendered[Number(e.target.dataset.i)]);
  }
});
$('#drawer').addEventListener('click', (e) => {
  if (e.target.id === 'drawer') closeDrawer();
});
$('#d-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

boot();
