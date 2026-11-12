import { geocode, nearestStopName, reachableFrom, journeyOptions } from './api.js';
import { buildCandidates, rank, refinementSet, mergeExact, MODES, TRANSFER_LEVELS } from './scoring.js';

const COLORS = ['#e6194b', '#3c78d8', '#2e9e5b', '#f08c00', '#8e44ad', '#00a3a3', '#d63384', '#795548'];
const MAX_PEOPLE = 8;
const SHOW_RESULTS = 10;
const REFINE_TOP = 5;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hasLoc = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon);

// ---- state ---------------------------------------------------------------
let people = [];
let nextId = 1;
let placingId = null;
let mode = 'total';
let lambda = 2;
let penalty = 5;          // minutes each transfer "costs"
let result = null;       // { people: snapshot, cands, whenISO }
let selectedKey = null;
let runId = 0;
let stale = false;

// ---- map -----------------------------------------------------------------
const map = L.map('map', { zoomControl: true }).setView([52.517, 13.389], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const personMarkers = new Map();
const stationLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);

const pinIcon = (p, i) => L.divIcon({
  className: '', iconSize: [26, 26], iconAnchor: [13, 30],
  html: `<div class="pin" style="background:${p.color}"><span>${i + 1}</span></div>`,
});

function syncMarkers() {
  for (const [id, m] of personMarkers) {
    if (!people.some((p) => p.id === id && hasLoc(p))) { m.remove(); personMarkers.delete(id); }
  }
  people.forEach((p, i) => {
    if (!hasLoc(p)) return;
    let m = personMarkers.get(p.id);
    if (!m) {
      m = L.marker([p.lat, p.lon], { draggable: true }).addTo(map);
      m.on('dragend', () => {
        const { lat, lng } = m.getLatLng();
        setLocation(p.id, lat, lng, null);
      });
      personMarkers.set(p.id, m);
    }
    m.setLatLng([p.lat, p.lon]);
    m.setIcon(pinIcon(p, i));
    m.bindTooltip(esc(p.name || `Person ${i + 1}`));
  });
}

map.on('click', (e) => {
  let target = people.find((p) => p.id === placingId)
    || people.find((p) => !hasLoc(p));
  if (!target) {
    if (people.length >= MAX_PEOPLE) return;
    target = addPerson();
  }
  placingId = null;
  setLocation(target.id, e.latlng.lat, e.latlng.lng, null);
});

// ---- people --------------------------------------------------------------
function addPerson(init = {}) {
  const used = new Set(people.map((p) => p.color));
  const p = {
    id: nextId++, name: init.name || '', label: init.label || '',
    lat: init.lat ?? NaN, lon: init.lon ?? NaN,
    color: COLORS.find((c) => !used.has(c)) || COLORS[people.length % COLORS.length],
  };
  people.push(p);
  renderPeople();
  return p;
}

function removePerson(id) {
  people = people.filter((p) => p.id !== id);
  if (placingId === id) placingId = null;
  markStale();
  renderPeople();
  syncMarkers();
  saveHash();
}

async function setLocation(id, lat, lon, label) {
  const p = people.find((x) => x.id === id);
  if (!p) return;
  p.lat = lat; p.lon = lon;
  p.label = label || `Pin ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  markStale();
  renderPeople();
  syncMarkers();
  saveHash();
  if (!label) {
    try {
      const near = await nearestStopName(lat, lon);
      if (near && p.lat === lat && p.lon === lon) {
        p.label = `Near ${near}`;
        renderPeople();
        saveHash();
      }
    } catch { /* keep coordinate label */ }
  }
}

function renderPeople() {
  const ul = $('#people');
  ul.innerHTML = '';
  people.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'person' + (placingId === p.id ? ' placing' : '');
    li.innerHTML = `
      <span class="dot" style="background:${p.color}"></span>
      <div class="fields">
        <input class="name" placeholder="Person ${i + 1}" value="${esc(p.name)}" aria-label="Name">
        <input class="addr" placeholder="Street, place or station…" value="${esc(hasLoc(p) ? p.label : (p.query || ''))}" aria-label="Address" autocomplete="off" spellcheck="false">
        <div class="where ${hasLoc(p) ? 'set' : ''}">${hasLoc(p) ? '✓ Location set' : placingId === p.id ? 'Click on the map…' : 'No location yet'}</div>
      </div>
      <div class="actions">
        <button type="button" class="place" title="Pick on map">📍</button>
        <button type="button" class="remove" title="Remove" ${people.length <= 2 ? 'disabled' : ''}>✕</button>
      </div>`;
    li.querySelector('.name').addEventListener('input', (e) => {
      p.name = e.target.value;
      syncMarkers();
      saveHash();
      if (result) renderResults();
    });
    li.querySelector('.place').addEventListener('click', () => {
      placingId = placingId === p.id ? null : p.id;
      renderPeople();
    });
    li.querySelector('.remove').addEventListener('click', () => removePerson(p.id));
    wireAutocomplete(li, p);
    ul.appendChild(li);
  });
  $('#add-person').disabled = people.length >= MAX_PEOPLE;
}

const KIND_LABEL = { stop: 'Station', address: 'Street', poi: 'Place' };

function wireAutocomplete(li, p) {
  const input = li.querySelector('.addr');
  let box = null, items = [], active = -1, timer = null, seq = 0, note = '';

  const hide = () => { box?.remove(); box = null; };
  const reset = () => { hide(); items = []; active = -1; note = ''; };
  const choose = (it) => { reset(); p.query = ''; setLocation(p.id, it.lat, it.lon, it.label); };

  const draw = () => {
    hide();
    if (!items.length && !note) return;
    box = document.createElement('ul');
    box.className = 'suggest';
    box.setAttribute('role', 'listbox');
    if (!items.length) {
      box.innerHTML = `<li class="note">${esc(note)}</li>`;
    }
    items.forEach((it, idx) => {
      const el = document.createElement('li');
      el.setAttribute('role', 'option');
      if (idx === active) el.className = 'active';
      el.innerHTML = `<span class="label">${esc(it.label)}</span><span class="kind ${it.kind}">${KIND_LABEL[it.kind] || it.kind}</span>`;
      el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it); });
      el.addEventListener('mousemove', () => {
        if (active !== idx) { active = idx; box.querySelectorAll('[role=option]').forEach((n, j) => n.classList.toggle('active', j === idx)); }
      });
      box.appendChild(el);
    });
    box.style.top = `${input.offsetTop + input.offsetHeight + 4}px`;
    li.appendChild(box);
  };

  const search = async (q) => {
    const my = ++seq;
    if (q.trim().length < 3) { items = []; note = ''; draw(); return null; }
    note = 'Searching…'; items = []; draw();
    try {
      const res = await geocode(q);
      if (my !== seq) return null;
      items = res; active = res.length ? 0 : -1;
      note = res.length ? '' : 'No matches. Try a street name with a house number, or a station.';
      if (document.activeElement === input) draw();
      return res;
    } catch {
      if (my !== seq) return null;
      items = []; note = 'Search failed. Check your connection.';
      if (document.activeElement === input) draw();
      return null;
    }
  };

  input.addEventListener('input', () => {
    p.query = input.value;
    const where = li.querySelector('.where');
    if (hasLoc(p)) {
      const changed = input.value !== p.label;
      where.className = 'where' + (changed ? '' : ' set');
      where.textContent = changed ? `Pick a suggestion to change it (still using: ${p.label})` : '✓ Location set';
    }
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value), 250);
  });
  input.addEventListener('focus', () => { if (items.length) draw(); });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      // Enter before suggestions arrived: search now and take the best match.
      const list = items.length ? items : await search(input.value);
      if (list?.length) choose(list[Math.max(active, 0)]);
      return;
    }
    if (!items.length) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % items.length; draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; draw(); e.preventDefault(); }
    else if (e.key === 'Escape') hide();
    else if (e.key === 'Tab' && active >= 0) choose(items[active]);
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
}

/** People who typed something but never picked a suggestion: use the top match. */
async function resolveTypedAddresses() {
  const pending = people.filter((p) => !hasLoc(p) && p.query?.trim().length >= 3);
  const failed = [];
  await Promise.all(pending.map(async (p) => {
    try {
      const [best] = await geocode(p.query);
      if (best) { p.lat = best.lat; p.lon = best.lon; p.label = best.label; p.query = ''; }
      else failed.push(p);
    } catch { failed.push(p); }
  }));
  if (pending.length) { renderPeople(); syncMarkers(); saveHash(); }
  return failed;
}

// ---- options -------------------------------------------------------------
function defaultWhen() {
  const d = new Date();
  const days = (6 - d.getDay() + 7) % 7 || 7; // next Saturday
  d.setDate(d.getDate() + days);
  d.setHours(18, 0, 0, 0);
  return toLocalInput(d);
}
function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

['#when', '#tram', '#regional'].forEach((s) => $(s).addEventListener('change', () => { markStale(); saveHash(); }));
$('#add-person').addEventListener('click', () => { addPerson(); saveHash(); });
$('#go').addEventListener('click', run);

let weightTimer;
const onWeightChange = () => {
  renderResults();
  saveHash();
  clearTimeout(weightTimer);
  weightTimer = setTimeout(() => result && refine(runId), 500);
};
$('#lambda').addEventListener('input', (e) => {
  lambda = Number(e.target.value);
  $('#lambda-out').textContent = lambda;
  onWeightChange();
});
const penaltyText = (v) => (v === 0 ? 'off' : `+${v} min per change`);
$('#penalty').addEventListener('input', (e) => {
  penalty = Number(e.target.value);
  $('#penalty-out').textContent = penaltyText(penalty);
  onWeightChange();
});

$('#share').addEventListener('click', async () => {
  saveHash();
  try {
    await navigator.clipboard.writeText(location.href);
    $('#share').textContent = 'Link copied ✓';
  } catch {
    prompt('Copy this link:', location.href);
  }
  setTimeout(() => { $('#share').textContent = 'Copy share link'; }, 2000);
});

// ---- status --------------------------------------------------------------
function setStatus(text, { error = false, progress = null } = {}) {
  const el = $('#status');
  el.className = error ? 'error' : '';
  el.innerHTML = esc(text) + (progress != null ? `<div class="progress"><div style="width:${Math.round(progress * 100)}%"></div></div>` : '');
}
function markStale() {
  if (result && !stale) {
    stale = true;
    setStatus('Inputs changed. Press "Find meeting point" to update.');
  }
}

// ---- run -----------------------------------------------------------------
async function run() {
  const failed = await resolveTypedAddresses();
  if (failed.length) {
    const who = failed.map((p) => `"${p.query}"`).join(', ');
    setStatus(`Couldn't find ${who}. Try a different spelling or click the map.`, { error: true });
    return;
  }
  const ps = people.filter(hasLoc);
  if (ps.length < 2) { setStatus('Set a location for at least two people. Type an address or click the map.', { error: true }); return; }
  const my = ++runId;
  const whenISO = new Date($('#when').value || defaultWhen()).toISOString();
  const opts = { includeTram: $('#tram').checked, includeRegional: $('#regional').checked };
  $('#go').disabled = true;
  stale = false;
  let done = 0;
  const calls = ps.length * TRANSFER_LEVELS.length;
  setStatus('Mapping where everyone can get to…', { progress: 0 });
  try {
    // One isochrone per person per max-transfer level (0, 1, 2, 3): tells us, for every
    // station, how fast each person gets there directly, with one change, etc.
    const reach = await Promise.all(ps.map(async (p) => {
      const levels = {};
      await Promise.all(TRANSFER_LEVELS.map(async (lvl) => {
        levels[lvl] = await reachableFrom(p, whenISO, { maxTransfers: lvl });
        done++;
        if (my === runId) setStatus('Mapping where everyone can get to…', { progress: done / calls });
      }));
      return levels;
    }));
    if (my !== runId) return;
    const cands = buildCandidates(reach, opts);
    if (!cands.length) {
      result = null;
      $('#results').hidden = true;
      setStatus('No station is reachable by everyone within 90 minutes. Check the pins (all in Berlin?).', { error: true });
      return;
    }
    result = { people: ps.map((p) => ({ ...p })), cands, whenISO };
    selectedKey = null;
    $('#results').hidden = false;
    renderResults();
    await refine(my);
  } catch (err) {
    if (my === runId) setStatus(err.message || String(err), { error: true });
  } finally {
    if (my === runId) $('#go').disabled = false;
  }
}

/** Replace isochrone estimates with exact journey times for the top candidates. */
async function refine(my) {
  if (!result) return;
  const { cands, people: ps, whenISO } = result;
  const todo = [];
  for (const c of refinementSet(cands, lambda, penalty, REFINE_TOP)) {
    ps.forEach((p, i) => { if (!c.exact[i]) todo.push({ c, i, p }); });
  }
  if (!todo.length) { if (!stale) setStatus(doneText()); return; }
  let done = 0, failed = 0, renderPending = false;
  const tick = () => {
    if (my !== runId) return;
    setStatus(`Checking exact journeys for the top stations… (${done}/${todo.length})`, { progress: done / todo.length });
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => { renderPending = false; if (my === runId) renderResults(); });
    }
  };
  tick();
  await Promise.all(todo.map(({ c, i, p }) => journeyOptions(p, c.id, whenISO)
    .then((o) => { if (o) { c.opts[i] = mergeExact(c.opts[i], o); c.exact[i] = true; } else failed++; })
    .catch(() => { failed++; })
    .finally(() => { done++; tick(); })));
  if (my !== runId) return;
  renderResults();
  if (!stale) setStatus(doneText() + (failed ? ` (${failed} journey lookups failed. Those times are estimates.)` : ''));
}

const doneText = () => `Compared ${result.cands.length} stations reachable by everyone.`;

// ---- results -------------------------------------------------------------
const lineBadges = (p) => `<span class="lines">${p.s ? '<i class="S">S</i>' : ''}${p.u ? '<i class="U">U</i>' : ''}${p.t ? '<i class="T">Tram</i>' : ''}${p.r && !p.s ? '<i class="R">RE</i>' : ''}</span>`;
const personName = (p, i) => people.find((x) => x.id === p.id)?.name || p.name || `Person ${i + 1}`;
const gmaps = (p, c, whenISO) => {
  const u = new URL('https://www.google.com/maps/dir/');
  u.searchParams.set('api', '1');
  u.searchParams.set('origin', `${p.lat},${p.lon}`);
  u.searchParams.set('destination', `${c.lat},${c.lon}`);
  u.searchParams.set('travelmode', 'transit');
  return u.toString();
};

function renderTabs() {
  const tabs = $('.tabs');
  tabs.innerHTML = '';
  for (const [key, m] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.textContent = m.label;
    b.setAttribute('aria-selected', String(key === mode));
    b.addEventListener('click', () => { mode = key; selectedKey = null; renderResults(); saveHash(); });
    tabs.appendChild(b);
  }
  $('#fairness').hidden = mode !== 'balanced';
}

function renderResults() {
  if (!result) return;
  renderTabs();
  const { people: ps, whenISO } = result;
  const ranked = rank(result.cands, mode, lambda, penalty).slice(0, SHOW_RESULTS);
  const maxT = Math.max(...ranked.flatMap((c) => c.stats.minutes));
  const changes = (n) => (n === 0 ? 'direct' : n === 1 ? '1 change' : `${n} changes`);
  if (!selectedKey || !ranked.some((c) => c.key === selectedKey)) selectedKey = ranked[0]?.key;

  const list = $('#result-list');
  list.innerHTML = '';
  ranked.forEach((c, idx) => {
    const s = c.stats;
    const allExact = c.exact.every(Boolean);
    const headline = mode === 'total' ? `${s.totalMinutes} min total`
      : mode === 'balanced' ? `score ${Math.round(s.balanced)}`
      : `≤ ${s.maxMinutes} min`;
    const t = s.minutes;
    const li = document.createElement('li');
    li.className = 'result' + (c.key === selectedKey ? ' selected' : '');
    li.innerHTML = `
      <div class="top">
        <span class="rank">${idx + 1}</span>
        <span class="name">${esc(c.name)} ${lineBadges(c.p)}</span>
        <span class="score">${headline}</span>
      </div>
      <div class="meta">${s.totalMinutes} min · ${s.totalTransfers === 0 ? 'all direct' : changes(s.totalTransfers)} · longest ${s.maxMinutes} min${penalty ? ` · score ${Math.round(mode === 'balanced' ? s.balanced : s.total)}` : ''}
        <span class="badge ${allExact ? 'exact' : ''}">${allExact ? 'exact' : 'estimate'}</span></div>
      <div class="bars">${ps.map((p, i) => `
        <div class="bar">
          <span class="who">${esc(personName(p, i))}</span>
          <span class="track"><span class="fill" style="display:block;width:${(t[i] / maxT) * 100}%;background:${p.color}"></span></span>
          <span class="min">${t[i]}′${c.exact[i] ? '' : '*'}</span>
          <span class="tr ${s.transfers[i] === 0 ? 'direct' : ''}">${s.transfers[i] === 0 ? 'direct' : `${s.transfers[i]}×`}</span>
        </div>`).join('')}
      </div>
      ${c.key === selectedKey ? `<div class="routes">Routes: ${ps.map((p, i) => `<a href="${gmaps(p, c, whenISO)}" target="_blank" rel="noopener">${esc(personName(p, i))}</a>`).join('')}</div>` : ''}`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      selectedKey = c.key;
      renderResults();
      focusSelected(ranked);
    });
    list.appendChild(li);
  });
  drawStations(ranked);
}

function drawStations(ranked) {
  stationLayer.clearLayers();
  routeLayer.clearLayers();
  const top = ranked.slice(0, 5);
  top.forEach((c, idx) => {
    const best = idx === 0;
    const m = L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', iconSize: best ? [30, 30] : [24, 24], html: `<div class="station-mark ${best ? 'best' : ''}">${idx + 1}</div>` }),
      zIndexOffset: best ? 1000 : 500 - idx,
    }).addTo(stationLayer);
    m.bindTooltip(`${esc(c.name)}: ${c.stats.totalMinutes} min total, longest ${c.stats.maxMinutes}, ${c.stats.totalTransfers} changes`);
    m.on('click', () => { selectedKey = c.key; renderResults(); });
  });
  const sel = ranked.find((c) => c.key === selectedKey);
  if (sel) {
    result.people.forEach((p, i) => {
      L.polyline([[p.lat, p.lon], [sel.lat, sel.lon]], { color: p.color, weight: 3, opacity: 0.8, dashArray: '6 6' })
        .bindTooltip(`${esc(personName(p, i))}: ${sel.stats.minutes[i]} min, ${sel.stats.transfers[i] === 0 ? 'direct' : `${sel.stats.transfers[i]}× change`}`)
        .addTo(routeLayer);
    });
  }
}

function focusSelected(ranked) {
  const sel = ranked.find((c) => c.key === selectedKey);
  if (!sel) return;
  const pts = [[sel.lat, sel.lon], ...result.people.map((p) => [p.lat, p.lon])];
  map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
}

// ---- URL hash (shareable state) -----------------------------------------
function saveHash() {
  const h = new URLSearchParams();
  for (const p of people) {
    if (!hasLoc(p) && !p.name) continue;
    h.append('p', [p.name, hasLoc(p) ? p.lat.toFixed(5) : '', hasLoc(p) ? p.lon.toFixed(5) : '', hasLoc(p) ? p.label : ''].join('|'));
  }
  if ($('#when').value) h.set('t', $('#when').value);
  if ($('#tram').checked) h.set('tram', '1');
  if ($('#regional').checked) h.set('re', '1');
  if (mode !== 'total') h.set('m', mode);
  if (penalty !== 5) h.set('x', penalty);
  if (lambda !== 2) h.set('l', lambda);
  history.replaceState(null, '', '#' + h.toString());
}

function loadHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const raw of h.getAll('p')) {
    const [name, lat, lon, ...label] = raw.split('|');
    addPerson({ name, lat: lat ? Number(lat) : NaN, lon: lon ? Number(lon) : NaN, label: label.join('|') });
  }
  $('#when').value = h.get('t') || defaultWhen();
  $('#tram').checked = h.get('tram') === '1';
  $('#regional').checked = h.get('re') === '1';
  if (MODES[h.get('m')]) mode = h.get('m');
  const num = (k, lo, hi) => { const v = Number(h.get(k)); return h.has(k) && v >= lo && v <= hi ? v : null; };
  penalty = num('x', 0, 15) ?? penalty;
  lambda = num('l', 0, 5) ?? lambda;
  $('#penalty').value = penalty;
  $('#penalty-out').textContent = penaltyText(penalty);
  $('#lambda').value = lambda;
  $('#lambda-out').textContent = lambda;
  return people.length;
}

// ---- boot ----------------------------------------------------------------
loadHash();
while (people.length < 2) addPerson();
if (people.length === 2 && !location.hash) { addPerson(); addPerson(); } // 4 by default
renderPeople();
syncMarkers();
const located = people.filter(hasLoc);
if (located.length) map.fitBounds(located.map((p) => [p.lat, p.lon]), { padding: [60, 60], maxZoom: 13 });
if (located.length >= 2) run();
