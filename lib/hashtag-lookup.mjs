// Looks up a single hashtag.
//
// TikTok's per-hashtag detail endpoint now requires a Creative Center login,
// so live lookups can only find hashtags that are in the public top list.
// parseDetail still describes the full detail shape (audience, related
// hashtags) and is used by the offline sample data.
import { fetchHashtagList, toRawHashtag, CreativeCenterError } from './creative-center.mjs';
import { normalizeItem } from './normalize.mjs';

// Creative Center reports audience age as a level number.
const AGE_LEVELS = { 3: '18–24', 4: '25–34', 5: '35+' };

export function cleanHashtag(input) {
  return String(input ?? '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .slice(0, 100);
}

function* walk(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  yield node;
  for (const v of Object.values(node)) yield* walk(v, seen);
}

const labelOf = (x) => {
  if (x == null) return null;
  if (typeof x === 'string') return x;
  return x.value ?? x.label ?? x.name ?? null;
};
const shareOf = (x) => {
  const n = Number(x.score ?? x.percentage ?? x.value ?? x.ratio);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
};

function audience(arr, labelFn) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({ label: labelFn(x), share: shareOf(x) }))
    .filter((x) => x.label && x.share != null)
    .sort((a, b) => b.share - a.share)
    .slice(0, 8);
}

export function parseDetail(name, data) {
  // The main record: an object for this hashtag that carries the most fields.
  let main = null;
  for (const node of walk(data)) {
    if (Array.isArray(node) || typeof node.hashtag_name !== 'string') continue;
    if (node.hashtag_name.toLowerCase() !== name) continue;
    if (!main || Object.keys(node).length > Object.keys(main).length) main = node;
  }
  if (!main) return null;

  // Related hashtags may be a list of records or of plain strings.
  let related = [];
  for (const node of walk(data)) {
    if (Array.isArray(node) || !node) continue;
    for (const [key, val] of Object.entries(node)) {
      if (!/related/i.test(key) || !Array.isArray(val)) continue;
      const names = val
        .map((x) => (typeof x === 'string' ? x : x?.hashtag_name))
        .filter((x) => typeof x === 'string' && x.toLowerCase() !== name);
      if (names.length > related.length) related = names;
    }
  }

  const item = normalizeItem('hashtags', main, 0);
  return {
    ...item,
    rank: Number.isFinite(Number(main.rank)) ? Number(main.rank) : null,
    postsInPeriod: Number(main.posts_last_period ?? main.publish_cnt) || null,
    postsTotal: Number(main.posts_total ?? main.publish_cnt_all) || null,
    viewsTotal: Number(main.video_views_all ?? main.views_all) || null,
    related: [...new Set(related.map((r) => r.replace(/^#/, '')))].slice(0, 15),
    audienceAges: audience(main.audience_ages, (x) =>
      typeof x.age_level === 'number' ? AGE_LEVELS[x.age_level] ?? `Age group ${x.age_level}` : labelOf(x.age_level ?? x.age),),
    audienceCountries: audience(main.audience_countries ?? main.audience_regions, (x) =>
      labelOf(x.country_info ?? x.region_info ?? x.country ?? x.country_code),
    ),
    audienceInterests: audience(main.audience_interests, (x) => labelOf(x.interest_info ?? x.interest)),
  };
}

export async function fetchHashtagDetail(name, { country = 'US', period = 7 } = {}, fetchImpl) {
  const items = await fetchHashtagList({ country, period }, fetchImpl);
  const index = items.findIndex((x) => x.hashtagName.toLowerCase() === name);
  if (index === -1) {
    const top = items.map((x) => `#${x.hashtagName}`).join(', ');
    throw Object.assign(
      new CreativeCenterError(
        `#${name} isn't in TikTok's public top hashtags right now${top ? ` (${top})` : ''}. ` +
          'Detailed lookups of any other hashtag now need a Creative Center login',
      ),
      { notFound: true },
    );
  }
  const detail = normalizeItem('hashtags', toRawHashtag(items[index], index), index);
  return {
    detail: {
      ...detail,
      postsInPeriod: detail.posts,
      postsTotal: null,
      viewsTotal: null,
      related: items.filter((_, i) => i !== index).map((x) => x.hashtagName),
      audienceAges: [],
      audienceCountries: [],
      audienceInterests: [],
      limited: true,
    },
  };
}
