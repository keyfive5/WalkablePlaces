// Step 2 — download OpenStreetMap data for every target city (resumable).
//
// For each city: find its centre (the OSM place node matching its name), define
// the analysis area (GHSL urban centre within ANALYSIS_RADIUS of the centre) and
// fetch intersections, destinations, pedestrian ways and highway/park geometry.
// Raw responses are cached under data-raw/osm/<id>/ so reruns never refetch.
//
// Usage: node pipeline/02-fetch-osm.mjs [--limit N] [--only id,id] [--max-gb 0.9]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { overpass, stats } from './lib/overpass.mjs';
import { buildQueries, parsePlaces } from '../docs/js/osm.js';
import { haversine, padBbox, bboxOf } from './lib/geo.mjs';
import { norm, sleep } from './lib/util.mjs';

export const ANALYSIS_RADIUS = 8000; // metres around the centre
const MARGIN = { pois: 1600, net: 500, ped: 500, geo: 800 };

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map((a) => a.trim().split(/\s+/)).map(([k, v]) => [k, v ?? true]));
const OSM = new URL('../data-raw/osm/', import.meta.url);
const targets = JSON.parse(readFileSync(new URL('../build/targets.json', import.meta.url), 'utf8'));
const catalog = new Map(JSON.parse(readFileSync(new URL('../build/catalog.json', import.meta.url), 'utf8')).map((c) => [c.id, c]));

const only = args.only ? new Set(String(args.only).split(',').map(Number)) : null;
const limit = args.limit ? Number(args.limit) : Infinity;
const maxBytes = (args['max-gb'] ? Number(args['max-gb']) : 0.9) * 1e9;

// Bytes already downloaded today count against the daily budget.
function bytesToday() {
  if (!existsSync(OSM)) return 0;
  const today = new Date().toDateString();
  let total = 0;
  for (const d of readdirSync(OSM)) for (const f of readdirSync(new URL(d + '/', OSM))) {
    const st = statSync(new URL(`${d}/${f}`, OSM));
    if (st.mtime.toDateString() === today) total += st.size;
  }
  return total;
}

function pickCentre(t, places) {
  if (t.fixedCentre) return { lat: t.lat, lon: t.lon, how: 'fixed' };
  const names = new Set([t.name, ...(catalog.get(t.id)?.names || [])].map(norm));
  const strip = (s) => s.replace(/\b(city|ciudad|municipality|metropolitan)\b/g, '').trim();
  const matches = (p) => [p.name, p.nameEn].filter(Boolean).map(norm).some((n) =>
    names.has(n) || [...names].some((m) => strip(m) === strip(n) && strip(n).length >= 3));
  const near = places.filter((p) => (p.place === 'city' || p.place === 'town') && haversine(t.lat, t.lon, p.lat, p.lon) < 25000);
  const named = near.filter(matches).sort((a, b) =>
    (b.place === 'city') - (a.place === 'city') || b.population - a.population ||
    haversine(t.lat, t.lon, a.lat, a.lon) - haversine(t.lat, t.lon, b.lat, b.lon));
  if (named.length) return { lat: named[0].lat, lon: named[0].lon, how: 'name:' + (named[0].nameEn || named[0].name) };
  const cities = near.filter((p) => p.place === 'city' && haversine(t.lat, t.lon, p.lat, p.lon) < 15000)
    .sort((a, b) => b.population - a.population);
  if (cities.length && cities[0].population) return { lat: cities[0].lat, lon: cities[0].lon, how: 'largest:' + (cities[0].nameEn || cities[0].name) };
  return { lat: t.lat, lon: t.lon, how: 'ghsl-centroid' };
}

function analysisBbox(t, centre) {
  const circle = padBbox({ s: centre.lat, n: centre.lat, w: centre.lon, e: centre.lon }, ANALYSIS_RADIUS);
  const poly = bboxOf(t.polygon.flat(2));
  return { s: Math.max(circle.s, poly.s), n: Math.min(circle.n, poly.n), w: Math.max(circle.w, poly.w), e: Math.min(circle.e, poly.e) };
}

async function fetchCity(t) {
  const dir = new URL(`${t.id}/`, OSM);
  mkdirSync(dir, { recursive: true });
  const file = (name) => new URL(name, dir);
  const label = `${t.name} (${t.iso3})`;

  // 1. places around the GHSL centroid → city centre + neighbourhood names
  if (!existsSync(file('places.csv'))) {
    const box = padBbox({ s: t.lat, n: t.lat, w: t.lon, e: t.lon }, 30000);
    const q = buildQueries({ places: box }, { timeout: 180 }).places;
    const { text } = await overpass(q, { label: label + ' places' });
    writeFileSync(file('places.csv'), text);
  }
  let meta = existsSync(file('meta.json')) ? JSON.parse(readFileSync(file('meta.json'), 'utf8')) : null;
  if (!meta) {
    const centre = pickCentre(t, parsePlaces(readFileSync(file('places.csv'), 'utf8')));
    const area = analysisBbox(t, centre);
    meta = { id: t.id, name: t.name, iso3: t.iso3, centre, area, radius: ANALYSIS_RADIUS,
      boxes: Object.fromEntries(Object.entries(MARGIN).map(([k, m]) => [k, padBbox(area, m)])), fetched: {} };
  }

  const queries = buildQueries(meta.boxes);
  for (const layer of ['net', 'pois', 'ped', 'geo']) {
    const name = layer + (layer === 'geo' ? '.json' : '.csv');
    if (existsSync(file(name))) continue;
    const { text, ms, endpoint } = await overpass(queries[layer], { label: `${label} ${layer}` });
    writeFileSync(file(name), text);
    meta.fetched[layer] = { bytes: text.length, ms, host: new URL(endpoint).host, at: new Date().toISOString() };
    writeFileSync(file('meta.json'), JSON.stringify(meta, null, 1));
    await sleep(1500);
  }
  writeFileSync(file('meta.json'), JSON.stringify(meta, null, 1));
  return meta;
}

let done = 0;
const startBytes = bytesToday();
console.log(`targets: ${targets.length}; already downloaded today: ${(startBytes / 1e6).toFixed(0)} MB`);
for (const t of targets) {
  if (only && !only.has(t.id)) continue;
  if (done >= limit) break;
  const complete = ['places.csv', 'net.csv', 'pois.csv', 'ped.csv', 'geo.json', 'meta.json']
    .every((f) => existsSync(new URL(`${t.id}/${f}`, OSM)));
  if (complete) continue;
  if (startBytes + stats.bytes > maxBytes) { console.log('daily download budget reached — stopping'); break; }
  const t0 = Date.now();
  try {
    const meta = await fetchCity(t);
    const mb = Object.values(meta.fetched).reduce((s, x) => s + x.bytes, 0) / 1e6;
    console.log(`✓ ${t.name} (${t.iso3}) centre=${meta.centre.how} ${mb.toFixed(1)} MB ${((Date.now() - t0) / 1000).toFixed(0)}s  [session ${(stats.bytes / 1e6).toFixed(0)} MB]`);
  } catch (err) {
    console.log(`✗ ${t.name} (${t.iso3}): ${err.message}`);
  }
  done++;
}
console.log('finished', stats);
