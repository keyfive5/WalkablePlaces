// Step 3 — score every extracted city on a 250 m hex grid and group hexes into
// neighbourhoods. Writes docs/data/city/<id>.json for the site.
//
// Usage: node pipeline/03-score.mjs [--only id,id] [--force] [--shard i/n]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Scorer, Projection, Grid, HEX_R, HEX_NEIGHBOURS, hexCenter, hexAt, hexAreaKm2, tierOf, TIERS, NEEDS, combine, dataQuality, DATA_FLOORS } from '../docs/js/model.js';
import { pointInPolygon } from './lib/geo.mjs';
import { popDensity } from './lib/population.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',').map(Number)) : null;
const force = args.includes('--force');
const [shard, shards] = (args.includes('--shard') ? args[args.indexOf('--shard') + 1] : '0/1').split('/').map(Number);

const RAW = new URL('../data-raw/ov/', import.meta.url);
const OUT = new URL('../docs/data/city/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const targets = new Map(JSON.parse(readFileSync(new URL('../build/targets.json', import.meta.url), 'utf8')).map((t) => [t.id, t]));

const CATS = Object.keys(NEEDS);
const HEX_AREA = hexAreaKm2();
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Bounding box of rings [[lon, lat]...] */
function ringsBox(rings) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return { w, s, e, n };
}

function scoreCity(raw, target) {
  const { centre } = raw;
  const proj = new Projection(centre.lat, centre.lon);
  const layers = {
    pois: raw.places.map(([x, y, c]) => ({ lat: y, lon: x, cat: CATS[c] })),
    stops: raw.stops.map(([x, y, kind]) => ({ lat: y, lon: x, kind })),
    intersections: raw.inter.map(([x, y]) => [y, x]),
    ped: { ways: raw.ped.map(([x, y, len]) => [y, x, len]), crossings: raw.crossings.map(([x, y]) => [y, x]) },
    geo: { motorways: raw.motorways, trunks: raw.trunks, parks: raw.parks },
  };
  const scorer = new Scorer(layers, centre.lat, centre.lon);

  // Hexes whose centre lies in the urban centre polygon, within the analysis radius,
  // and that actually contain streets (drops water, forests, airfields, rail yards).
  const polys = target.polygon.map((rings) => ({ rings, box: ringsBox(rings) }));
  const inUrban = (lon, lat) => polys.some(({ rings, box }) =>
    lon >= box.w && lon <= box.e && lat >= box.s && lat <= box.n && pointInPolygon(lon, lat, rings));
  const streetPts = new Grid(250);
  for (const [lat, lon] of layers.intersections) streetPts.add(proj.x(lon), proj.y(lat), 1);
  for (const [lat, lon] of layers.ped.ways) streetPts.add(proj.x(lon), proj.y(lat), 1);

  const R = raw.radius, qMax = Math.ceil(R / (HEX_R * 1.5)) + 1;
  const hexes = [];
  for (let q = -qMax; q <= qMax; q++) {
    for (let r = -2 * qMax; r <= 2 * qMax; r++) {
      const [x, y] = hexCenter(q, r);
      if (x * x + y * y > R * R) continue;
      const lat = proj.lat(y), lon = proj.lon(x);
      if (!inUrban(lon, lat)) continue;
      if (streetPts.count(x, y, HEX_R * 0.9) < 2) continue;
      hexes.push({ q, r, x, y, lat, lon });
    }
  }
  return { proj, scorer, hexes, layers };
}

// ---- neighbourhoods --------------------------------------------------------------

function assignLevel(hexes, cands, proj) {
  // Smallest polygons first, so the most specific name wins where areas overlap.
  const withPoly = cands.filter((c) => c.rings?.length).map((c) => ({ ...c, box: ringsBox(c.rings) }))
    .sort((a, b) => (a.box.e - a.box.w) * (a.box.n - a.box.s) - (b.box.e - b.box.w) * (b.box.n - b.box.s));
  const points = new Grid(1000);
  for (const c of cands) points.add(proj.x(c.x), proj.y(c.y), c);
  return hexes.map((h) => {
    for (const c of withPoly) {
      if (h.lon < c.box.w || h.lon > c.box.e || h.lat < c.box.s || h.lat > c.box.n) continue;
      // polygons from several parts: inside any outer ring (holes are rare at this level)
      if (c.rings.some((ring) => pointInPolygon(h.lon, h.lat, [ring]))) return c;
    }
    let best = null, bd = 2500;
    points.near(h.x, h.y, 2500, (d, c) => { if (!c.rings?.length && d < bd) { bd = d; best = c; } });
    return best;
  });
}

// Each hex takes the finest named area whose size is neighbourhood-like (roughly
// 1–20 km²), so central Paris gets its quartiers, Tokyo its wards and the suburbs
// their own towns. Levels are tried in this order of preference.
const PREFERENCE = ['neighborhood', 'macrohood', 'microhood', 'borough', 'localadmin', 'locality'];
const MIN_HEX = 6, MAX_HEX = 130;
// OSM place labels that aren't neighbourhoods.
const JUNK_NAME = /[()]|meeting point|assembly point|parking|\bstation\b|\bexit\b|\bgate\b|^\d+$/i;

function neighbourhoods(raw, hexes, proj) {
  const hoods = raw.hoods.filter((h) => (h.name || h.en) && !JUNK_NAME.test(h.en || h.name));
  const perLevel = [];
  for (const level of PREFERENCE) {
    const cands = hoods.filter((h) => h.type === level);
    if (!cands.length) continue;
    const assigned = assignLevel(hexes, cands, proj);
    const size = new Map();
    assigned.forEach((c) => c && size.set(c.id, (size.get(c.id) || 0) + 1));
    perLevel.push({ level, assigned, size });
  }
  const assigned = hexes.map((_, i) => {
    let fallback = null, fbDist = Infinity;
    for (const L of perLevel) {
      const c = L.assigned[i];
      if (!c) continue;
      const n = L.size.get(c.id);
      if (n >= MIN_HEX && n <= MAX_HEX) return c;
      const dist = n < MIN_HEX ? MIN_HEX / n : n / MAX_HEX;
      if (dist < fbDist && n >= 2 && n <= hexes.length * 0.5) { fbDist = dist; fallback = c; }
    }
    return fallback;
  });

  // Tidy: fold slivers (< 3 hexes) into the neighbouring area they touch most.
  const key = (q, r) => q + ',' + r;
  const at = new Map(hexes.map((h, i) => [key(h.q, h.r), i]));
  for (let pass = 0; pass < 3; pass++) {
    const size = new Map();
    assigned.forEach((c) => c && size.set(c.id, (size.get(c.id) || 0) + 1));
    hexes.forEach((h, i) => {
      const c = assigned[i];
      if (c && size.get(c.id) >= 3) return;
      const votes = new Map();
      for (const [dq, dr] of HEX_NEIGHBOURS) {
        const j = at.get(key(h.q + dq, h.r + dr));
        const o = j != null ? assigned[j] : null;
        if (o && o !== c && size.get(o.id) >= 3) votes.set(o, (votes.get(o) || 0) + 1);
      }
      const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      if (winner) assigned[i] = winner[0];
    });
  }
  const used = new Set(assigned.filter(Boolean).map((c) => c.type));
  return { level: [...used].join('+') || null, assigned };
}

// ---- main -----------------------------------------------------------------------
function weightedMean(items, key, wkey = 'w') {
  let s = 0, w = 0;
  for (const it of items) { s += it[key] * it[wkey]; w += it[wkey]; }
  return w ? s / w : 0;
}

async function processCity(id) {
  const raw = JSON.parse(gunzipSync(readFileSync(new URL(`${id}.json.gz`, RAW))).toString('utf8'));
  const target = targets.get(id);
  const t0 = Date.now();
  const { proj, scorer, hexes, layers } = scoreCity(raw, target);
  if (!hexes.length) return { id, skipped: 'no hexes' };

  for (const h of hexes) {
    const s = scorer.scoreAt(h.lat, h.lon);
    h.s = s.score; h.needs = s.needs; h.grid = s.grid; h.transit = s.transit; h.ped = s.ped; h.calm = s.calm;
    h.cat = CATS.map((c) => s.perCat[c].score);
    h.pop = (await popDensity(h.lat, h.lon)) * HEX_AREA;
    h.w = h.pop + 1; // unpopulated hexes still count, a little
  }

  // amenity counts per hex (destinations located inside it)
  const hexIndex = new Map(hexes.map((h, i) => [h.q + ',' + h.r, i]));
  const amen = hexes.map(() => new Array(CATS.length + 1).fill(0));
  for (const p of layers.pois) {
    const [q, r] = hexAt(proj.x(p.lon), proj.y(p.lat));
    const i = hexIndex.get(q + ',' + r);
    if (i != null) amen[i][CATS.indexOf(p.cat)]++;
  }
  for (const s of layers.stops) {
    const [q, r] = hexAt(proj.x(s.lon), proj.y(s.lat));
    const i = hexIndex.get(q + ',' + r);
    if (i != null) amen[i][CATS.length]++;
  }

  // Data coverage: destinations and stops per 1,000 residents of the analysed area.
  const totalPop = hexes.reduce((a, h) => a + h.pop, 0) || 1;
  const totals = amen.reduce((acc, row) => row.map((v, k) => v + acc[k]), new Array(CATS.length + 1).fill(0));
  const destPer1000 = (1000 * totals.slice(0, CATS.length).reduce((a, b) => a + b, 0)) / totalPop;
  const stopsPer1000 = (1000 * totals[CATS.length]) / totalPop;
  const transitMapped = stopsPer1000 >= DATA_FLOORS.stops;
  if (!transitMapped) for (const h of hexes) h.s = combine(h, { transit: false });

  const hood = neighbourhoods(raw, hexes, proj);
  const unitIds = new Map();
  const units = [];
  hood.assigned.forEach((c, i) => {
    if (!c) { hexes[i].u = -1; return; }
    if (!unitIds.has(c.id)) { unitIds.set(c.id, units.length); units.push({ c, hexes: [] }); }
    hexes[i].u = unitIds.get(c.id);
    units[hexes[i].u].hexes.push(i);
  });

  const summarise = (idx) => {
    const hs = idx.map((i) => hexes[i]);
    const pop = hs.reduce((a, h) => a + h.pop, 0);
    const counts = new Array(CATS.length + 1).fill(0);
    for (const i of idx) amen[i].forEach((v, k) => (counts[k] += v));
    const tiers = TIERS.map((t) => hs.filter((h) => tierOf(h.s) === t).reduce((a, h) => a + h.w, 0));
    const tw = tiers.reduce((a, b) => a + b, 0) || 1;
    return {
      score: round(weightedMean(hs, 's')),
      needs: round(100 * weightedMean(hs, 'needs')), grid: round(100 * weightedMean(hs, 'grid')),
      transit: round(100 * weightedMean(hs, 'transit')), ped: round(100 * weightedMean(hs, 'ped')),
      calm: round(100 * weightedMean(hs, 'calm')),
      cats: CATS.map((_, k) => round(100 * hs.reduce((a, h) => a + h.cat[k] * h.w, 0) / hs.reduce((a, h) => a + h.w, 0))),
      pop: Math.round(pop), hexes: hs.length, areaKm2: round(hs.length * HEX_AREA, 1),
      amen: Object.fromEntries([...CATS, 'stops'].map((c, k) => [c, counts[k]])),
      tiers: tiers.map((v) => round((100 * v) / tw)),
      lon: round(weightedMean(hs, 'lon'), 5), lat: round(weightedMean(hs, 'lat'), 5),
    };
  };

  // The town each neighbourhood sits in (smallest locality polygon around its centre), to tell
  // apart same-named areas and show which suburb a unit belongs to.
  const towns = raw.hoods.filter((h) => (h.type === 'locality' || h.type === 'localadmin') && h.rings?.length && (h.en || h.name))
    .map((h) => ({ name: h.en || h.name, rings: h.rings, box: ringsBox(h.rings) }))
    .sort((a, b) => (a.box.e - a.box.w) * (a.box.n - a.box.s) - (b.box.e - b.box.w) * (b.box.n - b.box.s));
  const townAt = (lon, lat) => towns.find((t) => lon >= t.box.w && lon <= t.box.e && lat >= t.box.s && lat <= t.box.n
    && t.rings.some((ring) => pointInPolygon(lon, lat, [ring])))?.name;
  const unitOut = units
    .map(({ c, hexes: idx }) => {
      const s = summarise(idx);
      const name = c.en || c.name;
      const town = c.type === 'locality' || c.type === 'localadmin' ? undefined : townAt(s.lon, s.lat);
      return { name, local: c.en && c.en !== c.name ? c.name : undefined, type: c.type, town: town && town !== name ? town : undefined, ...s };
    })
    .filter((u) => u.hexes >= 1);
  const summary = summarise(hexes.map((_, i) => i));

  const out = {
    v: 1, id, name: target.name, country: target.country, iso3: target.iso3,
    parentId: target.parentId, centre: [round(raw.centre.lon, 5), round(raw.centre.lat, 5)],
    hexR: HEX_R, radius: raw.radius, level: hood.level,
    summary,
    units: unitOut,
    hex: {
      q: hexes.map((h) => h.q), r: hexes.map((h) => h.r),
      s: hexes.map((h) => Math.round(h.s)),
      n: hexes.map((h) => Math.round(100 * h.needs)), g: hexes.map((h) => Math.round(100 * h.grid)),
      t: hexes.map((h) => Math.round(100 * h.transit)), p: hexes.map((h) => Math.round(100 * h.ped)),
      c: hexes.map((h) => Math.round(100 * h.calm)),
      pop: hexes.map((h) => Math.round(h.pop)), u: hexes.map((h) => h.u),
    },
    data: { quality: dataQuality(destPer1000), destPer1000: round(destPer1000, 2), stopsPer1000: round(stopsPer1000, 2), transitMapped },
    meta: { release: raw.release, centre: raw.centre.how, places: raw.places.length, stops: raw.stops.length, ms: Date.now() - t0 },
  };
  writeFileSync(new URL(`${id}.json`, OUT), JSON.stringify(out));
  return { id, name: target.name, hexes: hexes.length, units: unitOut.length, level: hood.level, score: summary.score, ms: Date.now() - t0, data: out.data };
}

const files = readdirSync(RAW).filter((f) => f.endsWith('.json.gz')).map((f) => Number(f.split('.')[0]));
let n = 0;
for (const [k, id] of files.entries()) {
  if (only && !only.has(id)) continue;
  if (k % shards !== shard) continue;
  const out = new URL(`${id}.json`, OUT);
  if (!force && existsSync(out) && statSync(out).mtimeMs > statSync(new URL(`${id}.json.gz`, RAW)).mtimeMs) continue;
  try {
    const r = await processCity(id);
    n++;
    console.log(r.skipped ? `- ${id} skipped: ${r.skipped}` : `✓ ${r.name}: ${r.score} (${r.hexes} hexes, ${r.units} units, data ${r.data.quality}${r.data.transitMapped ? '' : ', transit unmapped'}, ${r.ms} ms)`);
  } catch (err) {
    console.log(`✗ ${id}: ${err.stack}`);
  }
}
console.log('scored', n);
