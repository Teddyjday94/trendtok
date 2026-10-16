// Momentum scoring: turns a trend curve plus rank movement into a 0-100 score
// and a status label. This is the "predict what's about to go viral" part.

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Least-squares slope of values against their index, scaled by the series mean
// so curves of different magnitudes are comparable.
function relativeSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xBar = (n - 1) / 2;
  const yBar = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xBar) * (values[i] - yBar);
    den += (i - xBar) ** 2;
  }
  const slope = num / den;
  return yBar === 0 ? (slope > 0 ? 1 : 0) : slope / yBar;
}

export function scoreMomentum({ trend = [], rankChange = 0, isNew = false } = {}) {
  const values = trend.map((p) => Number(p.v)).filter((v) => Number.isFinite(v));
  let score = 50;

  if (values.length >= 3) {
    const third = Math.max(1, Math.floor(values.length / 3));
    const early = mean(values.slice(0, third));
    const late = mean(values.slice(-third));
    // Growth of the recent window over the early window, capped at 4x.
    const growth = early > 0 ? Math.min(late / early, 4) : late > 0 ? 4 : 1;
    score += (growth - 1) * 15;
    // Recent acceleration: slope over the last half of the curve.
    const recent = values.slice(-Math.max(3, Math.ceil(values.length / 2)));
    score += Math.max(-1, Math.min(1, relativeSlope(recent) * 4)) * 20;
  }

  if (Number.isFinite(rankChange) && rankChange !== 0) {
    score += Math.max(-15, Math.min(15, rankChange / 2));
  }
  if (isNew) score += 10;

  score = Math.round(Math.max(0, Math.min(100, score)));
  const status =
    score >= 75 ? 'breakout' : score >= 58 ? 'rising' : score >= 40 ? 'steady' : 'cooling';
  return { momentum: score, status };
}
