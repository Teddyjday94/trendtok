// Fake replies in the shape of Creative Center's public GetHashtagList endpoint
// (captured from the live site in October 2026).
export const ccItem = (name, rank, values = [10, 20, 30, 40, 50, 60, 70], extra = {}) => ({
  hashtagID: `id-${name}`,
  hashtagName: name,
  industryIDs: [],
  rankIndex: String(rank),
  publishCnt: String(1000 * rank),
  vv: String(5e6 / rank),
  popularityCurve: values.map((value, i) => ({ timestamp: String(1_791_504_000 + i * 86400), value })),
  topCreators: [],
  ...extra,
});

export const ccList = (items) =>
  Response.json({ BaseResp: { StatusCode: 0, StatusMessage: '' }, items, pagination: { hasMore: false, page: 1, totalCount: items.length } });

export const RISING = [5, 8, 12, 20, 35, 60, 95];
export const FLAT = [50, 50, 50, 50, 50, 50, 50];
