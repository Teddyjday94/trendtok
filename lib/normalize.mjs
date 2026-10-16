// Turns raw Creative Center records into one shape the UI understands.
// Field names follow what the Creative Center pages embed today; every lookup
// is defensive because TikTok changes these without notice.
import { scoreMomentum } from './momentum.mjs';

export const KINDS = ['hashtags', 'sounds', 'creators', 'videos'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const first = (obj, keys) => {
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return null;
};

function parseTrend(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => ({ t: num(p.time ?? p.t ?? p.date), v: num(p.value ?? p.v) }))
    .filter((p) => p.v !== null)
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

// rank_diff_type: 1 = up, 2 = unchanged, 3 = down, 4 = new entry.
function parseRankMove(raw) {
  const type = num(raw.rank_diff_type);
  const diff = Math.abs(num(raw.rank_diff) ?? 0);
  return {
    isNew: type === 4 || raw.is_new === true || raw.new_on_board === true,
    rankChange: type === 3 ? -diff : type === 2 ? 0 : diff,
  };
}

function industryOf(raw) {
  const info = raw.industry_info ?? raw.industry;
  if (!info) return null;
  if (typeof info === 'string') return info;
  return info.value ?? info.name ?? null;
}

const MAPPERS = {
  hashtags: (r) => ({
    id: String(first(r, ['hashtag_id', 'id', 'hashtag_name'])),
    name: `#${first(r, ['hashtag_name', 'name'])}`,
    subtitle: industryOf(r),
    industry: industryOf(r),
    posts: num(first(r, ['publish_cnt', 'post_cnt', 'video_count'])),
    views: num(first(r, ['video_views', 'vv', 'view_cnt'])),
    url: `https://www.tiktok.com/tag/${encodeURIComponent(first(r, ['hashtag_name', 'name']))}`,
    cover: null,
    promoted: Boolean(r.is_promoted),
  }),
  sounds: (r) => ({
    id: String(first(r, ['song_id', 'clip_id', 'id', 'title'])),
    name: first(r, ['title', 'song_name']),
    subtitle: first(r, ['author', 'artist']),
    industry: null,
    duration: num(r.duration),
    cover: first(r, ['cover', 'cover_url']),
    url: first(r, ['link', 'url']) ?? (r.clip_id ? `https://www.tiktok.com/music/x-${r.clip_id}` : null),
    promoted: Boolean(r.is_promoted),
  }),
  creators: (r) => ({
    id: String(first(r, ['tcm_id', 'user_id', 'id', 'nick_name'])),
    name: first(r, ['nick_name', 'nickname', 'unique_id']),
    subtitle: first(r, ['country_code', 'region']),
    industry: null,
    followers: num(first(r, ['follower_cnt', 'followers'])),
    likes: num(first(r, ['liked_cnt', 'likes'])),
    cover: first(r, ['avatar_url', 'avatar']),
    url: first(r, ['tt_link', 'profile_url']),
  }),
  videos: (r) => ({
    id: String(first(r, ['item_id', 'id'])),
    name: first(r, ['title', 'desc']) || 'Untitled video',
    subtitle: first(r, ['country_code', 'region']),
    industry: null,
    duration: num(r.duration),
    cover: first(r, ['cover', 'cover_url']),
    url: first(r, ['item_url', 'url']),
  }),
};

export function normalizeItem(kind, raw, index) {
  const base = MAPPERS[kind](raw);
  const trend = parseTrend(raw.trend);
  const move = parseRankMove(raw);
  return {
    kind,
    rank: num(raw.rank) ?? index + 1,
    trend,
    ...move,
    ...base,
    ...scoreMomentum({ trend, ...move }),
  };
}

export function normalizeList(kind, rawList) {
  return rawList.map((raw, i) => normalizeItem(kind, raw, i)).filter((x) => x.name);
}
