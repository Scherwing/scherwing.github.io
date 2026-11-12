// Pure scoring / ranking logic. No DOM, no network: easy to test with node.

/** Group key so that "S+U Alexanderplatz Bhf (Berlin)" and "S+U Alexanderplatz (Berlin) [U2]" merge. */
export function stationKey(name) {
  return name
    .toLowerCase()
    .replace(/\s*\((berlin|bln)\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/^(s\+u|s|u)\s+/, '')
    .replace(/^berlin\s+/, '')
    .replace(/\s+bhf\b.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function displayName(name) {
  return name.replace(/\s*\((Berlin|Bln)\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
}

function allowed(p, { includeTram, includeRegional }) {
  return p.s || p.u || (includeTram && p.t) || (includeRegional && p.r);
}

const productRank = (p) => (p.s ? 4 : 0) + (p.u ? 4 : 0) + (p.r ? 2 : 0) + (p.t ? 1 : 0);

/**
 * reach: array (one per person) of [{id, name, lat, lon, p, m}]
 * Returns candidates reachable by everyone:
 *   [{key, id, name, lat, lon, p, times: [min per person], exact: [bool]}]
 */
export function buildCandidates(reach, opts = {}) {
  const perPerson = reach.map((list) => {
    const byKey = new Map();
    for (const s of list) {
      if (!allowed(s.p, opts)) continue;
      const key = stationKey(s.name);
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, { ...s, key });
      else {
        // keep fastest time; keep the "most important" platform as representative
        const rep = productRank(s.p) > productRank(cur.p) ? { ...s, key } : cur;
        rep.m = Math.min(cur.m, s.m);
        rep.p = { s: cur.p.s || s.p.s, u: cur.p.u || s.p.u, t: cur.p.t || s.p.t, r: cur.p.r || s.p.r };
        byKey.set(key, rep);
      }
    }
    return byKey;
  });
  if (!perPerson.length) return [];
  const [first, ...rest] = perPerson;
  const out = [];
  for (const [key, s] of first) {
    if (!rest.every((m) => m.has(key))) continue;
    const entries = [s, ...rest.map((m) => m.get(key))];
    const rep = entries.reduce((a, b) => (productRank(b.p) > productRank(a.p) ? b : a));
    out.push({
      key, id: rep.id, name: displayName(rep.name), lat: rep.lat, lon: rep.lon, p: rep.p,
      times: entries.map((e) => e.m),
      exact: entries.map(() => false),
    });
  }
  return out;
}

export function stats(times, lambda = 2) {
  const total = times.reduce((a, b) => a + b, 0);
  const max = Math.max(...times);
  const min = Math.min(...times);
  const spread = max - min;
  return { total, max, min, spread, avg: total / times.length, balanced: total + lambda * spread };
}

export const MODES = {
  total: { label: 'Fastest total', key: (s) => [s.total, s.max] },
  balanced: { label: 'Balanced', key: (s) => [s.balanced, s.total] },
  minimax: { label: 'Shortest longest trip', key: (s) => [s.max, s.total] },
};

/** Rank candidates for a mode. Returns new objects with .stats attached. */
export function rank(cands, mode, lambda = 2) {
  const k = MODES[mode].key;
  return cands
    .map((c) => ({ ...c, stats: stats(c.times, lambda) }))
    .sort((a, b) => {
      const ka = k(a.stats), kb = k(b.stats);
      return ka[0] - kb[0] || ka[1] - kb[1] || a.name.localeCompare(b.name);
    });
}

/** Union of the top-n station keys across all modes: what we refine with exact journeys. */
export function refinementSet(cands, lambda, n = 8) {
  const keys = new Set();
  for (const mode of Object.keys(MODES)) rank(cands, mode, lambda).slice(0, n).forEach((c) => keys.add(c.key));
  return cands.filter((c) => keys.has(c.key));
}
