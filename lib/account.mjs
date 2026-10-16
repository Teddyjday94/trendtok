// Your connected TikTok account: stores encrypted tokens, keeps them fresh,
// and syncs your profile and videos. Each sync also saves a daily snapshot of
// follower count and per-video views, which is what growth charts are built from.
import { TikTokError } from './tiktok.mjs';

const MAX_SNAPSHOTS = 180;
const SNAPSHOT_VIDEOS = 60;

export function normalizeVideo(v) {
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return {
    id: String(v.id),
    createdAt: n(v.create_time) * 1000,
    title: v.title || '',
    description: v.video_description || '',
    duration: n(v.duration),
    cover: v.cover_image_url || null,
    url: v.share_url || null,
    views: n(v.view_count),
    likes: n(v.like_count),
    comments: n(v.comment_count),
    shares: n(v.share_count),
  };
}

const profileOf = (u) => ({
  openId: u.open_id,
  username: u.username || null,
  displayName: u.display_name || u.username || 'TikTok user',
  avatarUrl: u.avatar_url || null,
  profileUrl: u.profile_deep_link || (u.username ? `https://www.tiktok.com/@${u.username}` : null),
  bio: u.bio_description || '',
  verified: Boolean(u.is_verified),
  followers: u.follower_count ?? null,
  following: u.following_count ?? null,
  likes: u.likes_count ?? null,
  videoCount: u.video_count ?? null,
});

export function createAccount({ store, tiktok, auth }) {
  const getAccount = () => store.read('tiktok-account.json', null);

  const sealTokens = (t) => ({
    access: auth.encrypt(t.accessToken),
    refresh: auth.encrypt(t.refreshToken),
    expiresAt: t.expiresAt,
    refreshExpiresAt: t.refreshExpiresAt,
    scope: t.scope,
  });

  async function markBroken(message) {
    await store.update('tiktok-account.json', null, (a) => {
      if (a) Object.assign(a, { needsReconnect: true, lastError: message });
    });
  }

  async function accessToken() {
    const acct = await getAccount();
    if (!acct) throw new TikTokError('No TikTok account connected', { code: 'not_connected' });
    if (acct.tokens.expiresAt - 5 * 60_000 > Date.now()) return auth.decrypt(acct.tokens.access);
    try {
      const fresh = await tiktok.refresh(auth.decrypt(acct.tokens.refresh));
      await store.update('tiktok-account.json', null, (a) => {
        a.tokens = sealTokens(fresh);
      });
      return fresh.accessToken;
    } catch (err) {
      await markBroken('TikTok sign-in expired. Please reconnect your account.');
      throw err;
    }
  }

  return {
    getAccount,

    // Called after a successful OAuth callback. Returns the profile.
    async connect(tokens, user) {
      const profile = profileOf(user);
      await store.write('tiktok-account.json', {
        ...profile,
        tokens: sealTokens(tokens),
        connectedAt: Date.now(),
        lastSync: null,
        lastError: null,
        needsReconnect: false,
      });
      return profile;
    },

    async disconnect() {
      const acct = await getAccount();
      if (acct) {
        try {
          await tiktok.revoke(auth.decrypt(acct.tokens.access));
        } catch {
          // Already invalid; nothing to revoke.
        }
      }
      for (const name of ['tiktok-account.json', 'account-videos.json', 'account-snapshots.json']) {
        await store.write(name, null);
      }
    },

    async sync() {
      try {
        const token = await accessToken();
        const [user, rawVideos] = await Promise.all([tiktok.userInfo(token), tiktok.videos(token, { limit: 100 })]);
        const profile = profileOf(user);
        const videos = rawVideos.map(normalizeVideo).sort((a, b) => b.createdAt - a.createdAt);
        const now = Date.now();

        await store.write('account-videos.json', { at: now, videos });
        await store.update('account-snapshots.json', [], (snaps) => {
          const day = new Date(now).toISOString().slice(0, 10);
          const snap = {
            at: now,
            day,
            followers: profile.followers,
            likes: profile.likes,
            videoCount: profile.videoCount,
            views: Object.fromEntries(videos.slice(0, SNAPSHOT_VIDEOS).map((v) => [v.id, v.views])),
          };
          if (snaps.at(-1)?.day === day) snaps[snaps.length - 1] = snap;
          else snaps.push(snap);
          snaps.splice(0, Math.max(0, snaps.length - MAX_SNAPSHOTS));
        });
        await store.update('tiktok-account.json', null, (a) => {
          Object.assign(a, profile, { lastSync: now, lastError: null, needsReconnect: false });
        });
        return { at: now, videos: videos.length };
      } catch (err) {
        if (err.code === 'access_token_invalid' || err.code === 'scope_not_authorized') {
          await markBroken(`${err.message}. Please reconnect your account.`);
        } else if (err.code !== 'not_connected') {
          await store.update('tiktok-account.json', null, (a) => {
            if (a) a.lastError = err.message;
          });
        }
        throw err;
      }
    },

    async data() {
      const [account, videos, snapshots] = await Promise.all([
        getAccount(),
        store.read('account-videos.json', null),
        store.read('account-snapshots.json', []),
      ]);
      if (!account) return null;
      const { tokens, ...profile } = account;
      return { profile, videos: videos?.videos ?? [], syncedAt: videos?.at ?? null, snapshots: snapshots ?? [] };
    },
  };
}
