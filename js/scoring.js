// Pure scoring / ranking logic. No DOM, no network: easy to test with node.
//
// For every person × station we keep "options": { transfers: fastestMinutes }.
// e.g. { 0: 34, 1: 27, 2: 25 } means direct in 34 min, 27 min with one change, 25 with two.
// A trip's cost is  minutes + transferPenalty × transfers,  and each person takes the
// option with the lowest cost. Penalty 0 means "fastest, no matter how many changes".

export const TRANSFER_LEVELS = [0, 1, 2, 3];

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

/** Drop options that are not faster than an option with fewer transfers. */
export function pruneOptions(opts) {
  const out = {};
  let best = Infinity;
  for (const k of Object.keys(opts).map(Number).sort((a, b) => a - b)) {
    if (opts[k] < best) { out[k] = opts[k]; best = opts[k]; }
  }
  return out;
}

/** Cheapest option for one trip. Returns {m, tr, cost}. */
export function chooseOption(opts, penalty = 0) {
  let best = null;
  for (const [k, m] of Object.entries(opts)) {
    const tr = Number(k), cost = m + penalty * tr;
    if (!best || cost < best.cost || (cost === best.cost && tr < best.tr)) best = { m, tr, cost };
  }
  return best;
}

/**
 * reach: one entry per person, each an object { transfers: [{id, name, lat, lon, p, m}] }
 *        holding the isochrone computed with maxTransfers = that level.
 * Returns candidates reachable by everyone (at the highest level):
 *   [{key, id, name, lat, lon, p, opts: [{tr: min} per person], exact: [bool]}]
 */
export function buildCandidates(reach, filter = {}) {
  const perPerson = reach.map((levels) => {
    const byKey = new Map(); // key -> {rep, p, opts}
    for (const lvl of Object.keys(levels).map(Number)) {
      for (const s of levels[lvl]) {
        if (!allowed(s.p, filter)) continue;
        const key = stationKey(s.name);
        let e = byKey.get(key);
        if (!e) { e = { rep: s, p: { ...s.p }, opts: {} }; byKey.set(key, e); }
        if (productRank(s.p) > productRank(e.rep.p)) e.rep = s;
        for (const f of ['s', 'u', 't', 'r']) e.p[f] = e.p[f] || s.p[f];
        e.opts[lvl] = Math.min(e.opts[lvl] ?? Infinity, s.m);
      }
    }
    // Level k means "≤ k transfers"; keep only levels that actually save time.
    for (const e of byKey.values()) e.opts = pruneOptions(e.opts);
    return byKey;
  });
  if (!perPerson.length) return [];
  const [first, ...rest] = perPerson;
  const out = [];
  for (const [key] of first) {
    if (!rest.every((m) => m.has(key))) continue;
    const entries = perPerson.map((m) => m.get(key));
    const best = entries.reduce((a, b) => (productRank(b.rep.p) > productRank(a.rep.p) ? b : a));
    out.push({
      key, id: best.rep.id, name: displayName(best.rep.name), lat: best.rep.lat, lon: best.rep.lon, p: best.p,
      opts: entries.map((e) => e.opts),
      exact: entries.map(() => false),
    });
  }
  return out;
}

/** Merge exact journey options into isochrone options (journey values win per transfer level). */
export function mergeExact(isoOpts, journeyOpts) {
  return pruneOptions({ ...isoOpts, ...journeyOpts });
}

export function stats(cand, lambda = 2, penalty = 0) {
  const chosen = cand.opts.map((o) => chooseOption(o, penalty));
  const costs = chosen.map((c) => c.cost);
  const minutes = chosen.map((c) => c.m);
  const transfers = chosen.map((c) => c.tr);
  const total = costs.reduce((a, b) => a + b, 0);
  const max = Math.max(...costs);
  const min = Math.min(...costs);
  return {
    chosen, minutes, transfers,
    total, max, min, spread: max - min, avg: total / costs.length,
    balanced: total + lambda * (max - min),
    totalMinutes: minutes.reduce((a, b) => a + b, 0),
    totalTransfers: transfers.reduce((a, b) => a + b, 0),
    maxMinutes: Math.max(...minutes),
  };
}

export const MODES = {
  total: { label: 'Fastest total', key: (s) => [s.total, s.max] },
  balanced: { label: 'Balanced', key: (s) => [s.balanced, s.total] },
  minimax: { label: 'Shortest longest trip', key: (s) => [s.max, s.total] },
};

/** Rank candidates for a mode. Returns new objects with .stats attached. */
export function rank(cands, mode, lambda = 2, penalty = 0) {
  const k = MODES[mode].key;
  return cands
    .map((c) => ({ ...c, stats: stats(c, lambda, penalty) }))
    .sort((a, b) => {
      const ka = k(a.stats), kb = k(b.stats);
      return ka[0] - kb[0] || ka[1] - kb[1] || a.stats.totalTransfers - b.stats.totalTransfers || a.name.localeCompare(b.name);
    });
}

/** Union of the top-n station keys across all modes: what we refine with exact journeys. */
export function refinementSet(cands, lambda, penalty, n = 8) {
  const keys = new Set();
  for (const mode of Object.keys(MODES)) rank(cands, mode, lambda, penalty).slice(0, n).forEach((c) => keys.add(c.key));
  return cands.filter((c) => keys.has(c.key));
}
