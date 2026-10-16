// Email via Resend (https://resend.com). Used for alerts and the weekly report
// when running on Vercel, where desktop notifications aren't possible.
// Needs RESEND_API_KEY and ALERT_EMAIL. Without a verified domain, Resend's
// test sender (onboarding@resend.dev) can only send to your own Resend address.

export function createEmail({ apiKey, to, from = 'TrendTok <onboarding@resend.dev>', fetchImpl = globalThis.fetch }) {
  if (!apiKey || !to) return null;
  return {
    to,
    async send({ subject, html, text }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Email failed: ${body.message ?? `HTTP ${res.status}`}`);
      }
    },
  };
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const compact = (n) => (n == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n));
const signed = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toLocaleString('en-US')}`);

const shell = (title, body, appUrl) => `<!doctype html><html><body style="margin:0;background:#f4f4f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#15151c">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
<div style="background:#fff;border-radius:12px;padding:18px 20px">${body}</div>
${appUrl ? `<p style="font-size:13px;color:#62627a;margin-top:16px"><a href="${esc(appUrl)}" style="color:#e0204a">Open TrendTok</a></p>` : ''}
</div></body></html>`;

export function alertEmail(events, appUrl) {
  const subject = events.length === 1 ? `Trend alert: ${events[0].name}` : `${events.length} new trend alerts`;
  const rows = events
    .map((e) => `<p style="margin:0 0 12px"><b>${e.url ? `<a href="${esc(e.url)}" style="color:#15151c">${esc(e.name)}</a>` : esc(e.name)}</b> ${esc(e.reason)}<br>
      <span style="color:#62627a;font-size:13px">Keyword “${esc(e.keyword)}”${e.momentum != null ? ` · momentum ${e.momentum}` : ''}</span></p>`)
    .join('');
  return {
    subject,
    html: shell(subject, rows, appUrl),
    text: events.map((e) => `${e.name} ${e.reason} (keyword "${e.keyword}")`).join('\n'),
  };
}

export function weeklyReport({ profile, analysis, events = [], appUrl }) {
  const a = analysis;
  const subject = `Your TikTok week: ${signed(a.followers.change7d)} followers`;
  const top = [...a.videos].filter((v) => v.gained7d != null).sort((x, y) => y.gained7d - x.gained7d).slice(0, 3);
  const body = `
    <p style="margin:0 0 14px">Hi ${esc(profile.displayName)}, here's how <b>@${esc(profile.username ?? '')}</b> did this week.</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:14px">
      <tr><td>Followers</td><td style="text-align:right"><b>${compact(profile.followers)}</b> (${signed(a.followers.change7d)} this week)</td></tr>
      <tr><td>Typical views per video</td><td style="text-align:right"><b>${compact(a.totals.typicalViews)}</b></td></tr>
      <tr><td>Avg. engagement</td><td style="text-align:right"><b>${a.totals.avgEngagement}%</b></td></tr>
      <tr><td>Posts in the last 30 days</td><td style="text-align:right"><b>${a.totals.postsLast30}</b></td></tr>
    </table>
    ${top.length ? `<h2 style="font-size:15px;margin:16px 0 6px">Most views gained this week</h2>
      ${top.map((v) => `<p style="margin:0 0 6px">${v.url ? `<a href="${esc(v.url)}" style="color:#15151c">` : ''}${esc(v.title || v.description.slice(0, 70) || 'Untitled')}${v.url ? '</a>' : ''} · <b>+${compact(v.gained7d)}</b></p>`).join('')}` : ''}
    ${a.insights.length ? `<h2 style="font-size:15px;margin:16px 0 6px">What the numbers say</h2>
      <ul style="padding-left:18px;margin:0">${a.insights.map((i) => `<li style="margin-bottom:6px">${esc(i.text)}</li>`).join('')}</ul>` : ''}
    ${events.length ? `<h2 style="font-size:15px;margin:16px 0 6px">Trend alerts this week</h2>
      ${events.slice(0, 8).map((e) => `<p style="margin:0 0 6px"><b>${esc(e.name)}</b> ${esc(e.reason)}</p>`).join('')}` : ''}`;
  const text = [
    `Followers: ${profile.followers} (${signed(a.followers.change7d)} this week)`,
    ...a.insights.map((i) => `- ${i.text}`),
  ].join('\n');
  return { subject, html: shell('Your weekly TikTok report', body, appUrl), text };
}
