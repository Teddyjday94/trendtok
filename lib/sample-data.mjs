// Offline sample data in the same raw shape Creative Center uses, so it runs
// through the exact same normalizer. Seeded, so it is stable between reloads
// for a given country and period.
import { normalizeList } from './normalize.mjs';

function rng(seedText) {
  let h = 2166136261;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const HASHTAGS = [
  ['fyp', 'News & Entertainment'], ['booktok', 'Education'], ['grwm', 'Beauty & Personal Care'],
  ['cleantok', 'Home Improvement'], ['pressurewashing', 'Home Improvement'], ['foodtok', 'Food & Beverage'],
  ['fittok', 'Sports & Outdoor'], ['smallbusiness', 'Business Services'], ['outfitcheck', 'Apparel & Accessories'],
  ['carcare', 'Vehicle & Transportation'], ['lifehack', 'Education'], ['skincareroutine', 'Beauty & Personal Care'],
  ['airfryer', 'Food & Beverage'], ['gardentok', 'Home Improvement'], ['gymtok', 'Sports & Outdoor'],
  ['dayinmylife', 'News & Entertainment'], ['budgettravel', 'Travel'], ['petsoftiktok', 'Pets'],
  ['diyproject', 'Home Improvement'], ['mealprep', 'Food & Beverage'], ['studytok', 'Education'],
  ['sidehustle', 'Business Services'], ['satisfying', 'News & Entertainment'], ['makeuptutorial', 'Beauty & Personal Care'],
  ['roadtrip', 'Travel'], ['dogsoftiktok', 'Pets'], ['thriftflip', 'Apparel & Accessories'],
  ['beforeandafter', 'Home Improvement'], ['coffeetok', 'Food & Beverage'], ['techtok', 'Tech & Electronics'],
];
const SOUNDS = [
  ['Midnight Drive', 'Nova Lane'], ['Paper Hearts (Sped Up)', 'Kiro'], ['Golden Hour Loop', 'Sola'],
  ['Bounce Back', 'DJ Marlo'], ['original sound', 'cleanwithkay'], ['Static Love', 'The Veils'],
  ['Funk Machine', 'Groove Unit'], ['Slow Motion', 'Aria Bloom'], ['Run It Up', 'Taz'],
  ['Lo-fi Sunday', 'beatsbyrain'], ['Neon Nights', 'Velvet Club'], ['Oh No (Remix)', 'Capone Jr'],
  ['Wake Up Call', 'Mira'], ['Satisfying Clean ASMR', 'washsounds'], ['Summer Again', 'Coastline'],
  ['Countdown', 'Blue Arc'], ['Daydreamer', 'Lumi'], ['Heavy Bass Drop', 'Krane'],
  ['Little Things', 'June & Co'], ['Victory Lap', 'Rook'],
];
const CREATORS = [
  'cleanwithkay', 'chefmarco', 'fitbyjade', 'thebooknook', 'diydan', 'glowwithmia', 'roadtripraj',
  'petpals', 'techtam', 'sidehustlesam', 'washbrothers', 'thriftqueen', 'mealprepmike', 'studywithlee',
  'gardengurl',
];
const VIDEO_TITLES = [
  'Driveway transformation in 60 seconds', '3-ingredient breakfast hack', 'Morning routine that changed my life',
  'Rating every airport lounge', 'Thrift flip: $5 jacket', 'POV: first day at the new job',
  'This cleaning trick is illegal', 'Day 30 of learning guitar', 'Budget room makeover',
  'Dog reacts to new sibling', 'Testing viral gadgets so you don\'t have to', 'Restoring a 1990s truck',
  'What I eat in a day', 'Tiny business packing orders', 'Before and after deck stain',
];

function curve(rand, points, shape) {
  const out = [];
  let v = 0.2 + rand() * 0.3;
  const now = Math.floor(Date.now() / 86400000) * 86400;
  for (let i = 0; i < points; i++) {
    const drift = shape === 'up' ? 0.07 : shape === 'down' ? -0.05 : 0;
    v = Math.max(0.02, Math.min(1, v + drift + (rand() - 0.5) * 0.12));
    out.push({ time: now - (points - 1 - i) * 86400, value: Number(v.toFixed(3)) });
  }
  return out;
}

const shapeFor = (rand) => (rand() < 0.35 ? 'up' : rand() < 0.6 ? 'down' : 'flat');

function rankMove(rand) {
  const r = rand();
  if (r < 0.12) return { rank_diff_type: 4, rank_diff: 0 };
  if (r < 0.55) return { rank_diff_type: 1, rank_diff: 1 + Math.floor(rand() * 30) };
  if (r < 0.7) return { rank_diff_type: 2, rank_diff: 0 };
  return { rank_diff_type: 3, rank_diff: 1 + Math.floor(rand() * 20) };
}

const RAW = {
  hashtags: (rand, points) =>
    HASHTAGS.map(([name, industry], i) => ({
      hashtag_id: String(1000 + i), hashtag_name: name, rank: i + 1,
      industry_info: { id: i, value: industry },
      publish_cnt: Math.round(5e5 / (i + 1) + rand() * 2e4),
      video_views: Math.round(8e9 / (i + 1) + rand() * 1e8),
      trend: curve(rand, points, shapeFor(rand)), ...rankMove(rand),
    })),
  sounds: (rand, points) =>
    SOUNDS.map(([title, author], i) => ({
      song_id: String(7000 + i), clip_id: String(9000 + i), title, author, rank: i + 1,
      duration: 15 + Math.floor(rand() * 45), cover: null,
      trend: curve(rand, points, shapeFor(rand)), ...rankMove(rand),
    })),
  creators: (rand) =>
    CREATORS.map((nick, i) => ({
      tcm_id: String(3000 + i), nick_name: nick, rank: i + 1, country_code: 'US',
      follower_cnt: Math.round(9e6 / (i + 1) + rand() * 1e5),
      liked_cnt: Math.round(2e8 / (i + 1) + rand() * 1e6),
      tt_link: `https://www.tiktok.com/@${nick}`,
    })),
  videos: (rand) =>
    VIDEO_TITLES.map((title, i) => ({
      item_id: String(5000 + i), title, rank: i + 1, country_code: 'US',
      duration: 10 + Math.floor(rand() * 50), cover: null, item_url: null,
    })),
};

export function sampleData(kind, { country = 'US', period = 7 } = {}) {
  const rand = rng(`${kind}:${country}:${period}`);
  const points = Math.min(Number(period) || 7, 30);
  return normalizeList(kind, RAW[kind](rand, Math.max(points, 7)));
}
