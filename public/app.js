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

const state = { data: null, watchlist: [], loading: false, requestId: 0 };

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

function bigChart(trend) {
  const w = 480;
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
      <text x="${pad.l - 6}" y="${y(max * f) + 4}" text-anchor="end">${Math.round(f * 100)}</text>`)
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

function rowHtml(item, i) {
  const watched = isWatched(item);
  return `<div class="row" role="button" tabindex="0" data-i="${i}">
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
  $('#controls').hidden = tab === 'watchlist';
  $('#niche-wrap').hidden = tab !== 'hashtags';
  document.querySelectorAll('#period button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.period) === prefs.period)));

  if (tab === 'watchlist') return renderWatchlist();

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
      ${live.url ? `<a class="btn" href="${esc(live.url)}" target="_blank" rel="noopener">Open on TikTok ↗</a>` : ''}
    </div>`;
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
  if (prefs.tab === 'watchlist') return render();
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

// ---------- events ----------
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

$('#list').addEventListener('click', async (e) => {
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

api('/api/watchlist')
  .then((w) => {
    state.watchlist = w;
    render();
  })
  .catch(() => {});
load();
