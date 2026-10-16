// Fetches trend lists from TikTok Creative Center's public pages.
//
// The pages are Next.js apps that embed their first page of results in a
// <script id="__NEXT_DATA__"> JSON blob. Rather than hard-coding the path to
// the list (which TikTok moves around), we walk the JSON and pick the largest
// array whose items carry the fields that identify each kind of record.
import { normalizeList } from './normalize.mjs';

const BASE = 'https://ads.tiktok.com/business/creativecenter/inspiration/popular';

const PAGES = {
  hashtags: 'hashtag/pc/en',
  sounds: 'music/pc/en',
  creators: 'creator/pc/en',
  videos: 'pc/en',
};

// A record belongs to a kind when it has one of these keys.
const SIGNATURES = {
  hashtags: ['hashtag_name'],
  sounds: ['song_id', 'clip_id'],
  creators: ['nick_name', 'tcm_id'],
  videos: ['item_id', 'item_url'],
};

export function buildUrl(kind, { country = 'US', period = 7 } = {}) {
  const params = new URLSearchParams({ countryCode: country, period: String(period) });
  return `${BASE}/${PAGES[kind]}?${params}`;
}

export function extractNextData(html) {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function findRecords(kind, data) {
  const keys = SIGNATURES[kind];
  let best = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const matches = node.filter(
        (x) => x && typeof x === 'object' && !Array.isArray(x) && keys.some((k) => k in x),
      );
      if (matches.length > best.length && matches.length >= node.length / 2) best = matches;
      node.forEach(walk);
    } else {
      Object.values(node).forEach(walk);
    }
  };
  walk(data);
  return best;
}

export async function fetchPage(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Creative Center answered HTTP ${res.status}`);
  return res.text();
}

export async function fetchLive(kind, opts = {}, fetchImpl) {
  const url = buildUrl(kind, opts);
  const data = extractNextData(await fetchPage(url, fetchImpl));
  if (!data) throw new Error('Page had no embedded data (layout may have changed)');
  const records = findRecords(kind, data);
  if (!records.length) throw new Error(`No ${kind} found in page data (layout may have changed)`);
  return { items: normalizeList(kind, records), source: url };
}
