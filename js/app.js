// WalkablePlaces — app shell: routing, map ↔ panel wiring, search, compare.
import { store, loadWorld, loadCity, loadHoodIndex, subsOf } from './store.js';
import { MapView, METRICS } from './mapview.js';
import { worldView, countryView, cityView, hoodView, spotView, spotLoadingView, countryName, iso2Of } from './panels.js';
import { RAMP, SERIES, scoreColor, theme } from './colors.js';
import { SUBSCORES, TIERS, tierOf, Projection, hexAt, CATEGORY_LABELS } from './model.js';
import { esc, round, fmtPop, flag, animateIn, scoreChip, icons } from './ui.js';
import { aboutHtml } from './about.js';

const $ = (s) => document.querySelector(s);
const panelBody = $('#panel-body');
const ctx = { ui: {}, map: null, view: null, city: null };
const mobile = () => matchMedia('(max-width: 760px)').matches;
let routeToken = 0;

// ---- boot -------------------------------------------------------------------------------
const map = new MapView('map', { onHover: showTooltip, onClick: mapClick, onMoveStart: () => {} });
ctx.map = map;
window.__wp = ctx; // handy for debugging from the console
panelBody.innerHTML = '<div class="skeleton" style="height:160px"></div><div class="skeleton" style="height:90px;margin-top:16px"></div><div class="skeleton" style="height:320px;margin-top:16px"></div>';

Promise.all([loadWorld(), fetch(new URL('../data/countries.geojson', import.meta.url)).then((r) => r.json()), map.ready]).then(([world, shapes]) => {
  for (const f of shapes.features) {
    const c = store.countries.get(f.properties.iso3);
    f.properties.score = c ? c.score : null;
    f.properties.data = c ? c.data : null;
  }
  map.setCountries(shapes);
  map.setCities({
    type: 'FeatureCollection',
    features: store.cities.map((c) => ({ type: 'Feature', properties: { id: c.id, name: c.name, score: c.score, pop: c.pop, data: c.data, iso3: c.iso3 }, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } })),
  });
  renderLegend();
  window.addEventListener('hashchange', route);
  route();
  if (!location.hash || location.hash === '#/') map.spin();
}).catch((err) => {
  console.error(err);
  panelBody.innerHTML = `<p class="note">Couldn't load the data. Please refresh.</p>`;
});

// ---- routing ------------------------------------------------------------------------------
async function route() {
  const token = ++routeToken;
  const [kind, a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
  closeSearch();
  map.setSpot([]);
  spotMarker?.remove();
  try {
    if (kind === 'country') await showCountry(a.toUpperCase());
    else if (kind === 'city') await showCity(Number(a), b === 'n' ? Number(c) : null, token);
    else if (kind === 'at') await showSpot(...a.split(',').map(Number), token);
    else if (kind === 'compare') { await showWorld(); openCompare(decodeURIComponent(a || '')); }
    else if (kind === 'about') { await showWorld(); openAbout(); }
    else await showWorld();
  } catch (err) {
    console.error(err);
    render({ html: `<section><h1 class="title">Not found</h1><p class="subtitle">${esc(err.message)}</p><p><a class="btn" href="#/">Back to the world</a></p></section>` });
  }
}

function render(view, crumbs = []) {
  ctx.view = view;
  panelBody.innerHTML = view.html;
  panelBody.scrollTop = 0;
  view.mount?.(panelBody);
  animateIn(panelBody);
  $('#crumbs').innerHTML = [`<a href="#/">World</a>`, ...crumbs].join('<span class="sep">›</span>');
}

async function showWorld() {
  leaveCity();
  map.selectCountry(null);
  document.title = 'WalkablePlaces — How walkable is the world?';
  setMetricBar(false);
  render(worldView(ctx));
  if (map.map.getZoom() > 3 || map.map.getPitch() > 0) map.flyTo({ center: [map.map.getCenter().lng, 25], zoom: mobile() ? 0.9 : 1.75, pitch: 0, bearing: 0 });
}

async function showCountry(iso3) {
  leaveCity();
  map.stopSpin();
  map.selectCountry(iso3);
  setMetricBar(false);
  const name = countryName(iso3);
  document.title = `${name} — WalkablePlaces`;
  render(countryView(ctx, iso3), [`<span class="here">${flag(iso2Of(iso3))} ${esc(name)}</span>`]);
  const c = store.countries.get(iso3);
  const pts = store.cities.filter((x) => x.iso3 === iso3).map((x) => [x.lon, x.lat]);
  const label = c?.label;
  const anchor = label || pts[0];
  if (!anchor) return;
  // Bounds from the country's cities near its label point (ignores far-flung territories).
  const near = pts.filter(([lon, lat]) => Math.abs(lon - anchor[0]) < 25 && Math.abs(lat - anchor[1]) < 20);
  if (near.length >= 2) {
    const lons = near.map((p) => p[0]), lats = near.map((p) => p[1]);
    map.fitBounds([[Math.min(...lons) - 1, Math.min(...lats) - 1], [Math.max(...lons) + 1, Math.max(...lats) + 1]], { pitch: 0, bearing: 0 });
  } else map.flyTo({ center: anchor, zoom: 5, pitch: 0, bearing: 0 });
}

function leaveCity() {
  if (ctx.city) { map.setCity(null); ctx.city = null; }
  map.highlightUnit(null);
}

async function ensureCity(id, token) {
  if (ctx.city?.id === id) return ctx.city;
  map.stopSpin();
  render({ html: `<div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:240px;margin-top:16px"></div>` }, [`<span class="here">Loading…</span>`]);
  const city = await loadCity(id);
  if (token !== routeToken) return null;
  map.selectCountry(city.iso3);
  map.setCity(city);
  ctx.city = city;
  return city;
}

async function showCity(id, ui, token) {
  const city = await ensureCity(id, token);
  if (!city) return;
  setMetricBar(true);
  const crumbs = [`<a href="#/country/${city.iso3}">${flag(iso2Of(city.iso3))} ${esc(countryName(city.iso3))}</a>`];
  if (ui == null || !city.units[ui]) {
    map.highlightUnit(null);
    document.title = `${city.name} walkability — WalkablePlaces`;
    render(cityView(ctx, city), [...crumbs, `<span class="here">${esc(city.name)}</span>`]);
    const zoom = mobile() ? 10.2 : 10.9;
    map.flyTo({ center: city.centre, zoom: zoom - Math.log2(city.radius / 10000), pitch: map.is3D ? 52 : 0, bearing: map.is3D ? -14 : 0 });
  } else {
    const u = city.units[ui];
    map.highlightUnit(ui);
    document.title = `${u.name}, ${city.name} — WalkablePlaces`;
    render(hoodView(ctx, city, ui), [...crumbs, `<a href="#/city/${city.id}">${esc(city.name)}</a>`, `<span class="here">${esc(u.name)}</span>`]);
    map.fitBounds(unitBounds(city, ui), { maxZoom: 14.6, pitch: map.is3D ? 55 : 0, bearing: map.is3D ? -14 : 0, padding: 60 });
  }
}

function unitBounds(city, ui) {
  const proj = new Projection(city.centre[1], city.centre[0]);
  const R = city.hexR;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  city.hex.q.forEach((q, i) => {
    if (city.hex.u[i] !== ui) return;
    const x = R * 1.5 * q, y = R * Math.sqrt(3) * (city.hex.r[i] + q / 2);
    const lon = proj.lon(x), lat = proj.lat(y);
    w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
  });
  const pad = 0.004;
  return [[w - pad, s - pad], [e + pad, n + pad]];
}

// ---- live spot scoring -----------------------------------------------------------------------
let spotMarker = null;
let maplibreMod = null;
async function showSpot(lat, lon, token) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('That location could not be read.');
  map.stopSpin();
  maplibreMod ??= await import('../vendor/maplibre-gl-6.11.2/maplibre-gl.mjs');
  const el = document.createElement('div');
  el.className = 'marker-spot';
  spotMarker = new maplibreMod.Marker({ element: el }).setLngLat([lon, lat]).addTo(map.map);
  const hex = hexAtPoint(lat, lon);
  map.highlightUnit(null);
  setMetricBar(!!ctx.city);
  render({ html: spotLoadingView(lat, lon, hex) }, [`<span class="here">Spot</span>`]);
  if (map.map.getZoom() < 13.5) map.flyTo({ center: [lon, lat], zoom: 15, pitch: map.is3D ? 45 : 0 });
  const bar = panelBody.querySelector('[data-progress]'), txt = panelBody.querySelector('[data-progress-text]');
  const { scorePoint } = await import('./live.js');
  const namePromise = reverseGeocode(lat, lon);
  let r;
  try {
    r = await scorePoint(lat, lon, (d, n) => {
      if (bar) bar.style.width = `${(100 * d) / n}%`;
      if (txt) txt.textContent = `Reading map tiles · ${d} of ${n}`;
    });
  } catch (err) {
    if (token === routeToken) render({ html: `<section><h1 class="title">Couldn't score this spot</h1><p class="subtitle">The map tiles didn't load (${esc(err.message)}). Check your connection and try again.</p></section>` });
    return;
  }
  const placeName = await namePromise;
  if (token !== routeToken) return;
  ctx.lastSpot = { lat, lon, r, placeName };
  render(spotView(ctx, lat, lon, r, placeName), [`<span class="here">${esc(placeName || 'Spot')}</span>`]);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#60c2ff';
  const pts = [];
  for (const [cat, list] of Object.entries(r.nearest)) for (const n of list.slice(0, 3)) {
    if (n.lat == null) continue;
    pts.push({ type: 'Feature', properties: { kind: cat, name: n.name || CATEGORY_LABELS[cat], color: accent }, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } });
  }
  for (const s of r.stops.slice(0, 5)) pts.push({ type: 'Feature', properties: { kind: 'stop', name: s.name || s.kind, color: scoreColor(95) }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
  map.setSpot(pts);
}

function hexAtPoint(lat, lon) {
  const city = ctx.city;
  if (!city) return null;
  const proj = new Projection(city.centre[1], city.centre[0]);
  const [q, r] = hexAt(proj.x(lon), proj.y(lat), city.hexR);
  const i = city.hex.q.findIndex((qq, k) => qq === q && city.hex.r[k] === r);
  return i < 0 ? null : { s: city.hex.s[i], i };
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=en`, { signal: AbortSignal.timeout(5000) });
    const f = (await res.json()).features?.[0]?.properties;
    if (!f) return null;
    const first = f.name || [f.street, f.housenumber].filter(Boolean).join(' ');
    return [first, f.district || f.city || f.county].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ') || null;
  } catch { return null; }
}

// ---- map interaction -----------------------------------------------------------------------
function mapClick(hit, lngLat, zoom) {
  if (hit?.kind === 'city') location.hash = `#/city/${hit.id}`;
  else if (hit?.kind === 'country') location.hash = `#/country/${hit.id}`;
  else if (hit?.kind === 'hex') {
    const u = ctx.city.hex.u[hit.id];
    if (u >= 0 && map.activeUnit !== u) location.hash = `#/city/${ctx.city.id}/n/${u}`;
    else location.hash = `#/at/${lngLat.lat.toFixed(5)},${lngLat.lng.toFixed(5)}`;
  } else if (zoom >= 9) location.hash = `#/at/${lngLat.lat.toFixed(5)},${lngLat.lng.toFixed(5)}`;
}

const tooltip = $('#tooltip');
function showTooltip(hit, ev) {
  if (!hit || !ev || mobile()) { tooltip.hidden = true; return; }
  let html = '';
  if (hit.kind === 'country') {
    const c = store.countries.get(hit.id);
    html = `<div class="tt-head"><span class="tt-name">${flag(c?.iso2)} ${esc(countryName(hit.id))}</span>${c ? `<span class="tt-score">${scoreChip(c.score)}</span>` : ''}</div>
      <div class="tt-sub">${c ? `${tierOf(c.score).label} · ${c.cities} ${c.cities === 1 ? 'city' : 'cities'} scored${c.data >= 1.5 ? ' · limited data' : ''}` : 'Not scored yet'}</div>`;
  } else if (hit.kind === 'city') {
    const c = store.byId.get(hit.id);
    html = `<div class="tt-head"><span class="tt-name">${esc(c.name)}</span><span class="tt-score">${scoreChip(c.score)}</span></div>
      <div class="tt-sub">${esc(countryName(c.iso3))} · ${fmtPop(c.pop)} people</div>
      <div class="tt-sub">${tierOf(c.score).label}${c.rank ? ` · #${c.rank} of ${store.rankedCities}` : ' · limited data'}</div>
      <div class="tt-hint">Click to open its neighbourhoods</div>`;
  } else if (hit.kind === 'hex' && ctx.city) {
    const H = ctx.city.hex, i = hit.id, u = H.u[i];
    const vals = [H.n[i], H.g[i], H.t[i], H.p[i], H.c[i]];
    html = `<div class="tt-head"><span class="tt-name">${u >= 0 ? esc(ctx.city.units[u].name) : 'This block'}</span><span class="tt-score">${scoreChip(H.s[i])}</span></div>
      <div class="tt-sub">${tierOf(H.s[i]).label} · ~${fmtPop(H.pop[i])} residents in this 250 m cell</div>
      <div class="tt-bars">${SUBSCORES.map((s, k) => `<span>${s.label}</span><i><b style="width:${vals[k]}%;background:${scoreColor(vals[k])}"></b></i><span class="num">${vals[k]}</span>`).join('')}</div>
      <div class="tt-hint">${u >= 0 && map.activeUnit !== u ? 'Click for the neighbourhood' : 'Click to score this exact spot'}</div>`;
  }
  if (!html) { tooltip.hidden = true; return; }
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  const x = Math.min(ev.clientX, innerWidth - w - 30), y = Math.min(ev.clientY, innerHeight - h - 30);
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

// ---- metric bar + legend ------------------------------------------------------------------------
function setMetricBar(on) {
  const el = $('#metric');
  el.hidden = !on;
  if (on && !el.childElementCount) {
    el.innerHTML = METRICS.map((m) => `<button role="radio" data-metric="${m.key}" aria-checked="${map.metric === m.key}">${m.label}</button>`).join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-metric]');
      if (!b) return;
      map.setMetric(b.dataset.metric);
      el.querySelectorAll('[data-metric]').forEach((x) => x.setAttribute('aria-checked', x.dataset.metric === map.metric));
      renderLegend();
    });
  }
  renderLegend();
}

function renderLegend() {
  const m = METRICS.find((x) => x.key === map.metric);
  const ramp = RAMP[theme()];
  const inCity = !!ctx.city;
  $('#legend').innerHTML = `
    <div class="lg-title">${inCity ? esc(m.legend) : 'Walkability score'}<span>0–100</span></div>
    <div class="lg-ramp" style="background:linear-gradient(90deg, ${ramp.join(',')})"></div>
    <div class="lg-ticks">${[0, 30, 50, 70, 85, 100].map((v) => `<span style="left:${v}%">${v}</span>`).join('')}</div>
    <div class="lg-tiers"><span>Car-dependent</span><span>Walkable</span><span>Walker’s haven</span></div>
    ${inCity ? '' : '<div class="lg-nodata"><i></i>Hatched: limited map data</div>'}`;
}

// ---- controls -------------------------------------------------------------------------------------
$('#btn-3d').setAttribute('aria-pressed', String(map.is3D));
$('#btn-3d').addEventListener('click', () => {
  map.set3D(!map.is3D);
  $('#btn-3d').setAttribute('aria-pressed', String(map.is3D));
});
$('#btn-theme').addEventListener('click', () => {
  const next = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.documentElement.dataset.resolvedTheme = next;
  try { localStorage.setItem('wp-theme', next); } catch {}
  map.setTheme(next);
  map.map.once('style.load', () => { if (ctx.city) map.setCity(ctx.city); map.setMetric(map.metric); map.highlightUnit(map.activeUnit); });
  renderLegend();
  route();
});
$('#btn-locate').addEventListener('click', locate);
$('#btn-about').addEventListener('click', openAbout);

function locate() {
  if (!navigator.geolocation) return toast('Location is not available in this browser.');
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (p) => { location.hash = `#/at/${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`; },
    () => toast('Location permission was denied.'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

// Panel buttons (delegated).
panelBody.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action;
  if (a === 'surprise') {
    const pool = store.cities.filter((c) => c.data === 0 && c.units >= 5);
    location.hash = `#/city/${pool[Math.floor(Math.random() * pool.length)].id}`;
  } else if (a === 'locate') locate();
  else if (a === 'about') openAbout();
  else if (a === 'share') share();
  else if (a === 'compare') addCompare(JSON.parse(b.dataset.item));
  else if (a === 'spot') location.hash = `#/at/${Number(b.dataset.lat).toFixed(5)},${Number(b.dataset.lon).toFixed(5)}`;
});

async function share() {
  const url = location.href;
  try {
    if (navigator.share && mobile()) await navigator.share({ title: document.title, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch { /* cancelled */ }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---- search ---------------------------------------------------------------------------------------
const input = $('#search'), results = $('#search-results');
// Accent-insensitive, plus letters that don't decompose (Đà Nẵng → da nang, Łódź → lodz, Ørestad → orestad).
const LETTERS = { đ: 'd', ł: 'l', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i', þ: 'th', ð: 'd' };
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[đłøßæœıþð]/g, (c) => LETTERS[c]);
let searchSeq = 0, activeIdx = -1, items = [];

input.addEventListener('focus', () => { loadHoodIndex(); if (input.value.trim().length >= 2) runSearch(); });
input.addEventListener('input', () => runSearch());
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    results.querySelectorAll('.sr-item').forEach((el, i) => el.setAttribute('aria-selected', i === activeIdx));
    results.querySelectorAll('.sr-item')[activeIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const it = items[activeIdx >= 0 ? activeIdx : 0];
    if (it) { location.hash = it.href; input.blur(); }
  } else if (e.key === 'Escape') { closeSearch(); input.blur(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input && !e.target.closest?.('input,textarea')) { e.preventDefault(); input.focus(); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) closeSearch(); });
results.addEventListener('click', (e) => { if (e.target.closest('.sr-item')) { closeSearch(); input.blur(); } });

function closeSearch() { results.hidden = true; input.setAttribute('aria-expanded', 'false'); }

let geoTimer;
async function runSearch() {
  const seq = ++searchSeq;
  const q = fold(input.value.trim());
  if (q.length < 2) { closeSearch(); return; }
  const score = (name) => { const n = fold(name); return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(' ' + q) ? 2 : n.includes(q) ? 3 : 9; };
  const countries = [...store.countries.values()].map((c) => ({ c, s: score(c.name) })).filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s).slice(0, 3)
    .map(({ c }) => ({ href: `#/country/${c.iso3}`, name: c.name, sub: `Country · ${c.cities} cities`, lead: flag(c.iso2), score: c.score }));
  const cities = store.cities.map((c) => ({ c, s: score(c.name) })).filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || b.c.pop - a.c.pop).slice(0, 6)
    .map(({ c }) => ({ href: `#/city/${c.id}`, name: c.name, sub: `${countryName(c.iso3)} · ${fmtPop(c.pop)} people`, lead: flag(iso2Of(c.iso3)), score: c.score }));
  const idx = await loadHoodIndex();
  if (seq !== searchSeq) return;
  const hoods = [];
  for (const [name, cid, u, s, hexes, pop, , town] of idx) {
    const sc = score(name);
    const city = store.byId.get(cid);
    if (sc < 9 && city) hoods.push({ sc, pop, href: `#/city/${cid}/n/${u}`, name, sub: [town, city.name, countryName(city.iso3)].filter(Boolean).join(', '), score: s });
  }
  hoods.sort((a, b) => a.sc - b.sc || b.pop - a.pop);
  const groups = [['Countries', countries], ['Cities', cities], ['Neighbourhoods', hoods.slice(0, 6)]];
  drawResults(groups, q);
  clearTimeout(geoTimer);
  if (q.length >= 3) {
    geoTimer = setTimeout(async () => {
      try {
        const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(input.value.trim())}&limit=5&lang=en`);
        const fc = await res.json();
        if (seq !== searchSeq) return;
        const places = fc.features.map((f) => {
          const p = f.properties, [lon, lat] = f.geometry.coordinates;
          return { href: `#/at/${lat.toFixed(5)},${lon.toFixed(5)}`, name: p.name || p.street || 'Place', sub: [p.city, p.state, p.country].filter(Boolean).join(', '), lead: icons.pin.replace('<svg', '<svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2"'), score: null };
        });
        drawResults([...groups, ['Addresses & places — score live', places]], q);
      } catch { /* geocoder offline: local results still shown */ }
    }, 320);
  }
}

function drawResults(groups, q) {
  items = groups.flatMap(([, list]) => list);
  activeIdx = -1;
  results.innerHTML = items.length ? groups.filter(([, l]) => l.length).map(([title, list]) => `<div class="sr-group">${title}</div>` + list.map((it) => `
    <a class="sr-item" role="option" href="${it.href}">${it.lead || ''}<span class="sr-main"><span class="sr-name">${esc(it.name)}</span><span class="sr-sub">${esc(it.sub)}</span></span>${it.score != null ? scoreChip(it.score) : ''}</a>`).join('')).join('')
    : `<div class="sr-empty">No scored place matches “${esc(q)}”. Try an address to score it live.</div>`;
  results.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

// ---- compare -----------------------------------------------------------------------------------------
const compareItems = [];
try { compareItems.push(...JSON.parse(localStorage.getItem('wp-compare') || '[]')); } catch {}
renderTray();

async function resolveItem(it) {
  if (it.kind === 'country') {
    const c = store.countries.get(it.id);
    return c && { label: c.name, sub: 'Country', score: c.score, subs: c.subs };
  }
  if (it.kind === 'city') {
    const c = store.byId.get(it.id);
    return c && { label: c.name, sub: countryName(c.iso3), score: c.score, subs: c.subs };
  }
  if (it.kind === 'hood') {
    const [cid, ui] = String(it.id).split('.').map(Number);
    const city = await loadCity(cid);
    const u = city.units[ui];
    return u && { label: u.name, sub: city.name, score: u.score, subs: subsOf(u) };
  }
  if (it.kind === 'spot') return { label: it.label, sub: 'Spot', score: it.scores.score, subs: it.scores.subs };
  return null;
}

async function addCompare(item) {
  const key = item.kind + ':' + item.id;
  if (compareItems.some((x) => x.kind + ':' + x.id === key)) { openCompare(); return; }
  if (compareItems.length >= 4) compareItems.shift();
  const info = await resolveItem(item);
  if (!info) return;
  compareItems.push({ ...item, label: info.label, sub: info.sub, ...(item.kind === 'spot' ? { scores: item.scores } : {}) });
  persistCompare();
  renderTray();
  toast(compareItems.length > 1 ? `${info.label} added — ${compareItems.length} places to compare` : `${info.label} added. Add another place to compare.`);
}

function persistCompare() { try { localStorage.setItem('wp-compare', JSON.stringify(compareItems)); } catch {} }

function renderTray() {
  const tray = $('#tray');
  if (!compareItems.length) { tray.hidden = true; return; }
  const colors = SERIES[theme()];
  tray.hidden = false;
  tray.innerHTML = compareItems.map((it, i) => `<span class="tray-item"><i style="background:${colors[i]}"></i>${esc(it.label)}<button data-remove="${i}" aria-label="Remove ${esc(it.label)}">×</button></span>`).join('')
    + `<button class="btn primary" data-open ${compareItems.length < 2 ? 'disabled title="Add at least two places"' : ''}>${icons.compare}Compare ${compareItems.length}</button>`;
}
$('#tray').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) { compareItems.splice(Number(rm.dataset.remove), 1); persistCompare(); renderTray(); return; }
  if (e.target.closest('[data-open]') && compareItems.length >= 2) openCompare();
});

async function openCompare(fromUrl) {
  if (fromUrl) {
    const parsed = fromUrl.split(',').map((s) => { const [kind, id] = s.split(':'); return { kind, id: kind === 'city' ? Number(id) : kind === 'country' ? id.toUpperCase() : id }; }).filter((x) => x.kind && x.kind !== 'spot');
    compareItems.length = 0;
    for (const it of parsed.slice(0, 4)) { const info = await resolveItem(it); if (info) compareItems.push({ ...it, label: info.label, sub: info.sub }); }
    persistCompare(); renderTray();
  }
  const dlg = $('#compare');
  const colors = SERIES[theme()];
  const rows = await Promise.all(compareItems.map(resolveItem));
  const metrics = [{ label: 'Overall score', get: (r) => r.score }, ...SUBSCORES.map((s, k) => ({ label: s.label, get: (r) => r.subs[k] }))];
  const shareKey = compareItems.filter((x) => x.kind !== 'spot').map((x) => `${x.kind}:${x.id}`).join(',');
  dlg.innerHTML = `<div class="modal-inner">
    <button class="modal-close" data-close aria-label="Close">×</button>
    <h2 id="compare-title">Compare places</h2>
    <p class="muted">Every score is on the same 0–100 scale, measured the same way everywhere.</p>
    <div class="cmp-legend">${rows.map((r, i) => r ? `<div><i style="background:${colors[i]}"></i>${esc(r.label)} <small>${esc(r.sub)}</small></div>` : '').join('')}</div>
    <div class="cmp-grid">${metrics.map((m) => `<div class="cmp-metric"><span class="cmp-label">${m.label}</span><div class="cmp-bars">
      ${rows.map((r, i) => r ? `<div class="cmp-bar" title="${esc(r.label)}: ${round(m.get(r))}"><span class="bt"><span style="width:${Math.max(1, m.get(r) ?? 0)}%;background:${colors[i]}"></span></span><b>${m.get(r) == null ? 'n/a' : round(m.get(r))}</b></div>` : '').join('')}
    </div></div>`).join('')}</div>
    <h3>As a table</h3>
    <table class="data"><thead><tr><th>Place</th>${metrics.map((m) => `<th>${m.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => r ? `<tr><td>${esc(r.label)} <span class="muted">· ${esc(r.sub)}</span></td>${metrics.map((m) => `<td>${m.get(r) == null ? 'n/a' : round(m.get(r))}</td>`).join('')}</tr>` : '').join('')}</tbody></table>
    <div class="actions" style="margin-top:18px">
      ${shareKey ? `<button class="btn" data-copy="${esc(location.origin + location.pathname + '#/compare/' + shareKey)}">${icons.share}Copy comparison link</button>` : ''}
      <button class="btn" data-clear>Clear all</button>
    </div></div>`;
  dlg.onclick = async (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    const cp = e.target.closest('[data-copy]');
    if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast('Comparison link copied'); } catch {} }
    if (e.target.closest('[data-clear]')) { compareItems.length = 0; persistCompare(); renderTray(); dlg.close(); }
  };
  if (!dlg.open) dlg.showModal();
}

// ---- about ---------------------------------------------------------------------------------------
function openAbout() {
  const dlg = $('#about');
  dlg.innerHTML = `<div class="modal-inner"><button class="modal-close" data-close aria-label="Close">×</button>${aboutHtml(store)}</div>`;
  dlg.onclick = (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); };
  if (!dlg.open) dlg.showModal();
}

// ---- mobile bottom sheet ----------------------------------------------------------------------------
(function sheet() {
  const panel = $('#panel'), handle = panel.querySelector('.sheet-handle');
  const snaps = () => [0.22, 0.5, 0.9].map((f) => f * innerHeight);
  let startY = 0, startH = 0;
  const setH = (h) => { document.documentElement.style.setProperty('--sheet-h', h + 'px'); };
  handle.addEventListener('pointerdown', (e) => {
    startY = e.clientY; startH = panel.offsetHeight;
    panel.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!panel.classList.contains('dragging')) return;
    setH(Math.max(90, Math.min(innerHeight * 0.94, startH + startY - e.clientY)));
  });
  handle.addEventListener('pointerup', () => {
    panel.classList.remove('dragging');
    const h = panel.offsetHeight;
    setH(snaps().reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a)));
    map.setPadding();
  });
  input.addEventListener('focus', () => { if (mobile() && panel.offsetHeight < innerHeight * 0.5) setH(innerHeight * 0.9); });
})();

addEventListener('resize', () => map.setPadding());
