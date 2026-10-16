// Trend data from TikTok Creative Center.
//
// In late 2026 TikTok rebuilt Creative Center (ads.tiktok.com/creative/creativeCenter)
// and put most of its data behind a login. Without one, the only public data
// is the trending-hashtag list, capped at the top 3, for the 7- and 30-day
// periods. Sounds, creators, videos and per-hashtag details now answer
// "InvalidLogin" or "no permission". This module fetches what's public and
// reports the rest as needing a login rather than pretending.
import { normalizeList } from './normalize.mjs';

export const LIST_URL = 'https://ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const PUBLIC_NOTE =
  'TikTok now shows only its top 3 trending hashtags without a Creative Center login, so that is all this tab can show.';

const LOGIN_ONLY = {
  sounds: 'sounds',
  creators: 'creators',
  videos: 'videos',
};

export class CreativeCenterError extends Error {
  constructor(message, { loginRequired = false } = {}) {
    super(message);
    this.loginRequired = loginRequired;
  }
}

// The new API's hashtag records, converted to the field names normalize.mjs
// already understands (from the old Creative Center).
export function toRawHashtag(item, index) {
  return {
    hashtag_id: String(item.hashtagID ?? item.hashtagName),
    hashtag_name: item.hashtagName,
    rank: Number(item.rankIndex) || index + 1,
    publish_cnt: Number(item.publishCnt) || null,
    video_views: Number(item.vv) || null,
    trend: (item.popularityCurve ?? []).map((p) => ({ time: Number(p.timestamp), value: Number(p.value) })),
  };
}

export async function fetchHashtagList({ country = 'US', period = 7, limit = 20 } = {}, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(LIST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'agw-js-conv': 'str', 'user-agent': UA },
    body: JSON.stringify({ timeRange: Number(period), countryCode: country, page: 1, limit }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new CreativeCenterError(`Creative Center answered HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body) throw new CreativeCenterError('Creative Center sent an unreadable reply');
  const status = body.BaseResp?.StatusCode;
  if (status !== 0) {
    throw new CreativeCenterError(`Creative Center said: ${body.BaseResp?.StatusMessage || `error ${status}`}`, {
      loginRequired: /login/i.test(body.BaseResp?.StatusMessage ?? ''),
    });
  }
  return (body.items ?? []).filter((x) => x?.hashtagName);
}

export async function fetchLive(kind, { country = 'US', period = 7 } = {}, fetchImpl) {
  if (LOGIN_ONLY[kind]) {
    throw new CreativeCenterError(
      `TikTok now shows trending ${LOGIN_ONLY[kind]} only to people logged in to Creative Center, so this tab has no public data.`,
      { loginRequired: true },
    );
  }
  const items = await fetchHashtagList({ country, period }, fetchImpl);
  if (!items.length) {
    throw new CreativeCenterError(
      Number(period) > 30
        ? `TikTok doesn't share ${period}-day trends without a login. Try 7 or 30 days.`
        : `TikTok returned no public hashtags for ${country}.`,
      { loginRequired: Number(period) > 30 },
    );
  }
  return { items: normalizeList('hashtags', items.map(toRawHashtag)), note: PUBLIC_NOTE };
}
