// TikTok API for Business (the official Marketing API): connecting your ad
// account, and the Search Ads keyword tool that reports how many people search
// for a term on TikTok each month.
//
// Docs: https://business-api.tiktok.com/portal/docs
// Endpoint used: GET /open_api/v1.3/tool/search_keyword/recommend/
// (verified October 2026; it answers "access_token is empty" without a token).
const API = 'https://business-api.tiktok.com/open_api/v1.3';
const AUTH_URL = 'https://business-api.tiktok.com/portal/auth';

export class TikTokAdsError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function createTikTokAds({ appId, secret, fetchImpl = globalThis.fetch }) {
  async function call(path, { method = 'GET', token, query, body } = {}) {
    const url = new URL(API + path);
    // The Marketing API takes list parameters as JSON strings in the query.
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const res = await fetchImpl(url.toString(), {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { 'Access-Token': token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => null);
    if (!json) throw new TikTokAdsError(`TikTok Ads API answered HTTP ${res.status}`);
    if (json.code !== 0) throw new TikTokAdsError(`TikTok Ads API: ${json.message || `error ${json.code}`}`, json.code);
    return json.data ?? {};
  }

  return {
    configured: Boolean(appId && secret),

    authorizeUrl({ redirectUri, state }) {
      const q = new URLSearchParams({ app_id: appId, state, redirect_uri: redirectUri });
      return `${AUTH_URL}?${q}`;
    },

    // Returns a long-lived access token and the ad accounts it can use.
    async exchange(authCode) {
      const data = await call('/oauth2/access_token/', {
        method: 'POST',
        body: { app_id: appId, secret, auth_code: authCode },
      });
      return { accessToken: data.access_token, advertiserIds: (data.advertiser_ids ?? []).map(String), scope: data.scope };
    },

    // Up to 5 search queries per call; returns [{ keyword, monthlySearches }].
    async keywordRecommend(token, advertiserId, queries, { size = 200 } = {}) {
      const data = await call('/tool/search_keyword/recommend/', {
        token,
        query: {
          advertiser_id: advertiserId,
          regions: ['US'],
          search_queries: queries.slice(0, 5),
          order_field: 'MONTHLY_SEARCHES',
          order_type: 'DESC',
          page: 1,
          page_size: Math.min(size, 1000),
          total_size: Math.min(size, 1000),
        },
      });
      return (data.recommended_keywords ?? [])
        .filter((k) => k.recommended_keyword)
        .map((k) => ({ keyword: String(k.recommended_keyword).toLowerCase(), monthlySearches: Number(k.monthly_searches) || 0 }));
    },
  };
}
