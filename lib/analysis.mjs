// Turns your videos and daily snapshots into the numbers and plain-English
// insights on the My Account tab. Everything here is a pure function, so it is
// easy to test and runs the same locally and on Vercel.

const DAY = 86400_000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Four-hour blocks of the day.
export const BLOCKS = ['12–4am', '4–8am', '8am–12pm', '12–4pm', '4–8pm', '8pm–12am'];
const LENGTHS = [
  { label: 'Under 15s', max: 15 },
  { label: '15–30s', max: 30 },
  { label: '30–60s', max: 60 },
  { label: '1–3 min', max: 180 },
  { label: 'Over 3 min', max: Infinity },
];
// Videos younger than this are still collecting views, so they're left out
// of "what works" comparisons.
const MATURE_DAYS = 3;

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const fmtX = (x) => `${round(x, 1)}×`;

export function hashtagsOf(text) {
  return [...new Set((String(text).match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1).toLowerCase()))];
}

function zoned(ms, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  } catch {
    return zoned(ms, 'UTC');
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: SHORT_DAYS.indexOf(get('weekday')), hour: Number(get('hour')) % 24 };
}

// Group mature videos and compare each group to your typical (median) views.
function groupPerformance(videos, keyFn, typical) {
  const groups = new Map();
  for (const v of videos) {
    for (const key of [].concat(keyFn(v))) {
      if (key == null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
  }
  return [...groups.entries()].map(([key, vs]) => ({
    key,
    count: vs.length,
    performance: typical ? round(median(vs.map((v) => v.views)) / typical, 2) : 0,
    engagement: round(mean(vs.map((v) => v.engagement)), 2),
  }));
}

function viewsAt(snapshots, id, beforeMs) {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].at <= beforeMs && snapshots[i].views?.[id] != null) return snapshots[i].views[id];
  }
  return null;
}

export function analyze({ videos = [], snapshots = [], timeZone = 'UTC', trending = [], now = Date.now() }) {
  const enriched = videos.map((v) => {
    const ageDays = Math.max((now - v.createdAt) / DAY, 1 / 24);
    const interactions = v.likes + v.comments + v.shares;
    const t = zoned(v.createdAt, timeZone);
    return {
      ...v,
      ageDays: round(ageDays, 1),
      engagement: v.views ? round((interactions / v.views) * 100, 2) : 0, // percent
      viewsPerDay: Math.round(v.views / ageDays),
      tags: hashtagsOf(`${v.title} ${v.description}`),
      day: t.day,
      block: Math.floor(t.hour / 4),
    };
  });

  const mature = enriched.filter((v) => v.ageDays >= MATURE_DAYS);
  const typical = median(mature.map((v) => v.views)) || median(enriched.map((v) => v.views));

  // Per-video performance against your typical video, and recent view gains.
  const latest = snapshots.at(-1);
  for (const v of enriched) {
    v.performance = typical ? round(v.views / typical, 2) : 0;
    v.label = v.ageDays >= MATURE_DAYS && v.performance >= 2 ? 'hit' : v.ageDays >= MATURE_DAYS && v.performance <= 0.5 ? 'low' : null;
    const weekAgo = viewsAt(snapshots, v.id, now - 6.5 * DAY);
    v.gained7d = weekAgo == null ? null : Math.max(0, v.views - weekAgo);
  }

  // "Taking off": gained far more views since the previous snapshot than its usual daily pace.
  const takingOff = [];
  if (snapshots.length >= 2) {
    const prev = snapshots.at(-2);
    const days = Math.max((latest.at - prev.at) / DAY, 0.25);
    for (const v of enriched) {
      const a = prev.views?.[v.id];
      const b = latest.views?.[v.id];
      if (a == null || b == null) continue;
      const recentPerDay = (b - a) / days;
      const usualPerDay = a / Math.max(v.ageDays - days, 1);
      if (recentPerDay >= Math.max(usualPerDay * 2, typical * 0.25, 200)) {
        takingOff.push({ id: v.id, title: v.title || v.description.slice(0, 80), url: v.url, perDay: Math.round(recentPerDay) });
      }
    }
  }

  // Follower growth from snapshots.
  const followerSeries = snapshots.filter((s) => s.followers != null).map((s) => ({ at: s.at, v: s.followers }));
  const changeSince = (ms) => {
    const nowF = followerSeries.at(-1);
    const then = [...followerSeries].reverse().find((p) => p.at <= now - ms);
    return nowF && then ? nowF.v - then.v : null;
  };

  // What works: time of week, length, hashtags.
  const times = groupPerformance(mature, (v) => `${v.day}:${v.block}`, typical).map((g) => {
    const [day, block] = g.key.split(':').map(Number);
    return { ...g, day, block };
  });
  const dayTotals = groupPerformance(mature, (v) => v.day, typical);
  const lengths = groupPerformance(mature, (v) => LENGTHS.findIndex((l) => v.duration < l.max), typical)
    .map((g) => ({ ...g, label: LENGTHS[g.key].label }))
    .sort((a, b) => a.key - b.key);
  const tags = groupPerformance(mature, (v) => v.tags, typical)
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.performance - a.performance);

  // Posting frequency over the last 30 days.
  const last30 = enriched.filter((v) => now - v.createdAt <= 30 * DAY).length;

  // Trending hashtags you have and haven't used.
  const used = new Set(enriched.flatMap((v) => v.tags));
  const hot = trending.filter((t) => t.status === 'breakout' || t.status === 'rising' || t.isNew);
  const trendingUsed = hot.filter((t) => used.has(t.name.replace(/^#/, '').toLowerCase()));
  const trendingNew = hot.filter((t) => !used.has(t.name.replace(/^#/, '').toLowerCase())).slice(0, 10);

  const insights = buildInsights({ mature, enriched, typical, times, dayTotals, lengths, tags, takingOff, last30, trendingNew, trendingUsed });

  return {
    totals: {
      videos: enriched.length,
      views: enriched.reduce((a, v) => a + v.views, 0),
      typicalViews: Math.round(typical),
      avgEngagement: round(mean(enriched.map((v) => v.engagement)), 2),
      postsLast30: last30,
    },
    followers: { series: followerSeries, change7d: changeSince(7 * DAY), change30d: changeSince(30 * DAY) },
    videos: enriched,
    takingOff,
    times,
    lengths,
    tags: tags.slice(0, 15),
    trendingUsed: trendingUsed.map((t) => ({ name: t.name, status: t.status, rank: t.rank })),
    trendingNew: trendingNew.map((t) => ({ name: t.name, status: t.status, rank: t.rank, industry: t.industry })),
    insights,
    enoughData: mature.length >= 5,
  };
}

function buildInsights({ mature, enriched, typical, times, dayTotals, lengths, tags, takingOff, last30, trendingNew, trendingUsed }) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });

  for (const v of takingOff.slice(0, 2)) {
    add('hot', `“${v.title || 'One of your videos'}” is taking off: about ${v.perDay.toLocaleString('en-US')} views a day right now. Reply to its comments and consider a follow-up video while it's hot.`);
  }

  if (mature.length < 5) {
    add('info', `Only ${mature.length} of your videos are old enough to compare (${MATURE_DAYS}+ days). Patterns get reliable after about 10.`);
  }

  const bestTime = times.filter((t) => t.count >= 2).sort((a, b) => b.performance - a.performance)[0];
  if (bestTime && bestTime.performance >= 1.3) {
    add('time', `Videos you post on ${DAYS[bestTime.day]}s ${BLOCKS[bestTime.block]} get ${fmtX(bestTime.performance)} your typical views (${bestTime.count} videos).`);
  } else {
    const bestDay = dayTotals.filter((d) => d.count >= 2).sort((a, b) => b.performance - a.performance)[0];
    if (bestDay && bestDay.performance >= 1.3) {
      add('time', `${DAYS[bestDay.key]} is your strongest day: those videos get ${fmtX(bestDay.performance)} your typical views (${bestDay.count} videos).`);
    }
  }

  const ranked = lengths.filter((l) => l.count >= 2).sort((a, b) => b.performance - a.performance);
  if (ranked.length >= 2 && ranked[0].performance >= ranked.at(-1).performance * 1.4) {
    add('length', `${ranked[0].label} videos do best for you (${fmtX(ranked[0].performance)} typical views), while ${ranked.at(-1).label.toLowerCase()} videos get ${fmtX(ranked.at(-1).performance)}.`);
  }

  if (tags[0] && tags[0].performance >= 1.5) {
    add('tag', `Videos with #${tags[0].key} get ${fmtX(tags[0].performance)} your typical views (${tags[0].count} videos). Keep using it where it fits.`);
  }
  const weakTag = tags.filter((t) => t.count >= 3).at(-1);
  if (weakTag && weakTag !== tags[0] && weakTag.performance <= 0.6) {
    add('tag', `#${weakTag.key} hasn't helped so far: ${weakTag.count} videos at ${fmtX(weakTag.performance)} typical views.`);
  }

  const topEngagement = [...mature].sort((a, b) => b.engagement - a.engagement)[0];
  if (topEngagement && topEngagement.engagement > 0) {
    add('engage', `Your most engaging video is “${topEngagement.title || topEngagement.description.slice(0, 60) || 'untitled'}” at ${topEngagement.engagement}% likes, comments and shares per view. Whatever it did is worth repeating.`);
  }

  add('cadence', last30 === 0
    ? 'You haven\'t posted in the last 30 days.'
    : `You posted ${last30} video${last30 === 1 ? '' : 's'} in the last 30 days.`);

  if (trendingNew[0]) {
    const names = trendingNew.slice(0, 3).map((t) => t.name).join(', ');
    add('trend', `Trending now that you haven't used: ${names}. If one fits your work, a video on it this week could catch the wave.`);
  }
  if (trendingUsed[0]) {
    add('trend', `You've already used ${trendingUsed.map((t) => t.name).slice(0, 3).join(', ')}, which ${trendingUsed.length === 1 ? 'is' : 'are'} trending right now.`);
  }
  if (!enriched.length) add('info', 'No public videos found on this account yet.');
  return out;
}
