// Thin client for the free BVG HAFAS REST API (https://v6.bvg.transport.rest).
// No API key, CORS enabled, rate limit ~100 requests/minute.

const BASE = 'https://v6.bvg.transport.rest';
const MAX_CONCURRENT = 4;

// Rough bounding box: Berlin plus Potsdam. Keeps candidates out of Wittenberg & co.
const BBOX = { minLat: 52.33, maxLat: 52.69, minLon: 12.95, maxLon: 13.80 };

// ---- request queue -------------------------------------------------------
let active = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(path, params, { retries = 3, timeout = 45000 } = {}) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      if (attempt >= retries) throw new Error(`Network error talking to BVG API (${err.message})`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    const msg = res.status === 429 ? 'BVG API rate limit hit – wait a minute and retry.' : `BVG API error ${res.status}`;
    throw new Error(msg);
  }
}

// ---- caching -------------------------------------------------------------
const mem = new Map();
function lsGet(key, ttl) {
  try {
    const c = JSON.parse(localStorage.getItem('bm:' + key));
    if (c && Date.now() - c.t < ttl) return c.v;
  } catch { /* storage unavailable */ }
  return undefined;
}
function lsSet(key, v) {
  try { localStorage.setItem('bm:' + key, JSON.stringify({ t: Date.now(), v })); }
  catch {
    // Quota full: drop our old entries and try once more.
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('bm:')).forEach((k) => localStorage.removeItem(k));
      localStorage.setItem('bm:' + key, JSON.stringify({ t: Date.now(), v }));
    } catch { /* give up silently */ }
  }
}
async function cached(key, { ttl = 6 * 3600e3, persist = true } = {}, producer) {
  if (mem.has(key)) return mem.get(key);
  if (persist) {
    const v = lsGet(key, ttl);
    if (v !== undefined) { mem.set(key, Promise.resolve(v)); return v; }
  }
  const p = producer();
  mem.set(key, p);
  try {
    const v = await p;
    if (persist) lsSet(key, v);
    return v;
  } catch (e) {
    mem.delete(key);
    throw e;
  }
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;

// ---- public API ----------------------------------------------------------

/** Address / stop / POI search. Returns [{label, lat, lon, kind}] */
export async function geocode(query) {
  const q = query.trim();
  if (q.length < 3) return [];
  return cached(`geo:${q.toLowerCase()}`, { persist: false }, async () => {
    const data = await fetchJSON('/locations', {
      query: q, results: 12, addresses: true, stops: true, poi: true, linesOfStops: false, language: 'de',
    }, { retries: 1, timeout: 15000 });
    const kindOrder = { stop: 0, address: 1, poi: 2 };
    const seen = new Set();
    return data
      .map((l) => {
        const lat = l.latitude ?? l.location?.latitude;
        const lon = l.longitude ?? l.location?.longitude;
        const kind = l.type === 'stop' || l.type === 'station' ? 'stop' : l.poi ? 'poi' : 'address';
        const label = kind === 'stop' ? cleanName(l.name) : (l.address || l.name);
        return { label, lat, lon, kind, inBerlin: /\((Berlin|Bln)\)|\bBerlin-|\d{5} Berlin\b|, Berlin$/.test(l.address || l.name || '') };
      })
      .filter((l) => Number.isFinite(l.lat) && l.label)
      .filter((l) => { const k = l.label.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      // Berlin first, then stations, streets, places. Stable within groups (API relevance).
      .map((l, i) => ({ ...l, i }))
      .sort((a, b) => (b.inBerlin - a.inBerlin) || (kindOrder[a.kind] - kindOrder[b.kind]) || a.i - b.i)
      .slice(0, 7)
      .map(({ inBerlin, i, ...l }) => l);
  });
}

/** Name of the nearest stop, used to label pins dropped on the map. */
export async function nearestStopName(lat, lon) {
  return cached(`near:${r5(lat)},${r5(lon)}`, { persist: false }, async () => {
    const data = await fetchJSON('/locations/nearby', { latitude: lat, longitude: lon, results: 1, distance: 1500 }, { retries: 1, timeout: 15000 });
    return data[0] ? cleanName(data[0].name) : null;
  });
}

/**
 * Every rail/tram station reachable from a point (isochrone).
 * Returns [{id, name, lat, lon, p: {s,u,t,r}, m: minutes}]
 */
export async function reachableFrom({ lat, lon, label }, whenISO, maxDuration = 90) {
  const key = `reach:${r5(lat)},${r5(lon)}:${whenISO}:${maxDuration}`;
  return cached(key, {}, async () => {
    const data = await fetchJSON('/stops/reachable-from', {
      latitude: lat, longitude: lon, address: label || 'Start',
      maxDuration, maxTransfers: 3, when: whenISO,
    }, { timeout: 60000 });
    const out = [];
    for (const group of data.reachable || []) {
      for (const s of group.stations) {
        const p = s.products || {};
        if (!(p.suburban || p.subway || p.tram || p.regional)) continue;
        const la = s.location?.latitude, lo = s.location?.longitude;
        if (la < BBOX.minLat || la > BBOX.maxLat || lo < BBOX.minLon || lo > BBOX.maxLon) continue;
        out.push({
          id: s.id, name: s.name, lat: la, lon: lo,
          p: { s: !!p.suburban, u: !!p.subway, t: !!p.tram, r: !!p.regional },
          m: group.duration,
        });
      }
    }
    return out;
  });
}

/**
 * Exact door-to-station travel time in minutes (best of the next few journeys,
 * measured from first departure to arrival, so waiting at home doesn't count).
 */
export async function journeyMinutes({ lat, lon, label }, stopId, whenISO) {
  const key = `jny:${r5(lat)},${r5(lon)}:${stopId}:${whenISO}`;
  return cached(key, {}, async () => {
    const data = await fetchJSON('/journeys', {
      'from.latitude': lat, 'from.longitude': lon, 'from.address': label || 'Start',
      to: stopId, departure: whenISO, results: 4,
      stopovers: false, remarks: false, scheduledDays: false,
    });
    let best = null;
    for (const j of data.journeys || []) {
      const legs = j.legs;
      const dep = new Date(legs[0].plannedDeparture || legs[0].departure);
      const arr = new Date(legs.at(-1).plannedArrival || legs.at(-1).arrival);
      const mins = Math.round((arr - dep) / 60000);
      if (best === null || mins < best) best = mins;
    }
    return best;
  });
}

export function cleanName(name) {
  return name
    .replace(/\s*\((Berlin|Bln)\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .trim();
}
