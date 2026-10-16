// Sessions, cookies and token encryption.
//
// A session is a signed cookie: base64url(JSON payload) + "." + HMAC. Nothing
// about the session is stored server-side, so it works on serverless.
// TikTok tokens are stored encrypted (AES-256-GCM) with a key derived from
// SESSION_SECRET, so a leaked database alone doesn't expose your account.
import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'tt_session';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function createAuth({ secret, secure = false }) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const macKey = createHash('sha256').update(`mac:${secret}`).digest();
  const encKey = createHash('sha256').update(`enc:${secret}`).digest();

  const sign = (data) => createHmac('sha256', macKey).update(data).digest('base64url');
  const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  };

  function cookie(name, value, { maxAge, path = '/' } = {}) {
    const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
    if (secure) parts.push('Secure');
    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    return parts.join('; ');
  }

  return {
    // payload: { sub, via } -> Set-Cookie header value
    issueSession(payload) {
      const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + SESSION_DAYS * 86400_000 }));
      return cookie(SESSION_COOKIE, `${body}.${sign(body)}`, { maxAge: SESSION_DAYS * 86400 });
    },
    clearSession: () => cookie(SESSION_COOKIE, '', { maxAge: 0 }),
    readSession(req) {
      const raw = parseCookies(req)[SESSION_COOKIE];
      if (!raw) return null;
      const [body, mac] = raw.split('.');
      if (!body || !mac || !safeEqual(sign(body), mac)) return null;
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return payload.exp > Date.now() ? payload : null;
      } catch {
        return null;
      }
    },

    // Short-lived signed cookie carrying the OAuth state, to stop forged callbacks.
    issueState() {
      const state = b64url(randomBytes(24));
      return { state, header: cookie('tt_oauth_state', `${state}.${sign(state)}`, { maxAge: 600, path: '/api/auth' }) };
    },
    checkState(req, state) {
      const raw = parseCookies(req).tt_oauth_state;
      if (!raw || !state) return false;
      const [value, mac] = raw.split('.');
      return safeEqual(value, state) && safeEqual(sign(value), mac);
    },
    clearState: () => cookie('tt_oauth_state', '', { maxAge: 0, path: '/api/auth' }),

    checkPassword: (given, expected) =>
      Boolean(expected) && safeEqual(createHash('sha256').update(String(given)).digest('hex'), createHash('sha256').update(expected).digest('hex')),

    encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map(b64url).join('.');
    },
    decrypt(blob) {
      const [iv, tag, data] = String(blob).split('.').map((p) => Buffer.from(p, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
