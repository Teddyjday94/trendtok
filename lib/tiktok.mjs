// TikTok Login Kit (OAuth 2.0) and the Display API: your profile and your
// public videos with their view, like, comment and share counts.
// Docs: https://developers.tiktok.com/doc/login-kit-web and
//       https://developers.tiktok.com/doc/display-api-overview
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';

export const SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'];

const USER_FIELDS = [
  'open_id', 'avatar_url', 'display_name', 'username', 'bio_description', 'profile_deep_link',
  'is_verified', 'follower_count', 'following_count', 'likes_count', 'video_count',
];
const VIDEO_FIELDS = [
  'id', 'create_time', 'cover_image_url', 'share_url', 'video_description', 'duration', 'title',
  'like_count', 'comment_count', 'share_count', 'view_count',
];

export class TikTokError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createTikTok({ clientKey, clientSecret, fetchImpl = globalThis.fetch }) {
  async function call(url, init) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    // Token endpoints put errors at the top level; data endpoints in body.error.
    const errCode = body.error?.code ?? body.error;
    if (!res.ok || (errCode && errCode !== 'ok')) {
      const message = body.error?.message || body.error_description || body.message || `HTTP ${res.status}`;
      throw new TikTokError(`TikTok: ${message}`, { code: errCode || null, status: res.status });
    }
    return body;
  }

  const form = (fields) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
    body: new URLSearchParams(fields).toString(),
  });

  const tokens = (b) => ({
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    openId: b.open_id,
    scope: b.scope,
    expiresAt: Date.now() + (Number(b.expires_in) || 86400) * 1000,
    refreshExpiresAt: Date.now() + (Number(b.refresh_expires_in) || 365 * 86400) * 1000,
  });

  return {
    authorizeUrl({ redirectUri, state }) {
      const q = new URLSearchParams({
        client_key: clientKey,
        scope: SCOPES.join(','),
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
      });
      return `${AUTH_URL}?${q}`;
    },

    async exchangeCode({ code, redirectUri }) {
      return tokens(
        await call(`${API}/oauth/token/`, form({
          client_key: clientKey,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        })),
      );
    },

    async refresh(refreshToken) {
      return tokens(
        await call(`${API}/oauth/token/`, form({
          client_key: clientKey,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        })),
      );
    },

    async revoke(accessToken) {
      await call(`${API}/oauth/revoke/`, form({ client_key: clientKey, client_secret: clientSecret, token: accessToken }));
    },

    async userInfo(accessToken) {
      const body = await call(`${API}/user/info/?fields=${USER_FIELDS.join(',')}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return body.data?.user ?? {};
    },

    // Most recent videos first, up to `limit`, 20 per page.
    async videos(accessToken, { limit = 100 } = {}) {
      const all = [];
      let cursor;
      while (all.length < limit) {
        const body = await call(`${API}/video/list/?fields=${VIDEO_FIELDS.join(',')}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor } : {}) }),
        });
        const page = body.data?.videos ?? [];
        all.push(...page);
        if (!body.data?.has_more || !page.length) break;
        cursor = body.data.cursor;
      }
      return all.slice(0, limit);
    },
  };
}
