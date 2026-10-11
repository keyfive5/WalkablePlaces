// Raw metric distributions per city (population-weighted percentiles) — used to set model thresholds.
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Scorer, Projection, hexCenter, NEEDS, Grid } from '../docs/js/model.js';
import { popDensity } from './lib/population.mjs';
const CATS = Object.keys(NEEDS);
const ids = (process.argv[2] || '').split(',').filter(Boolean).map(Number);
const pct = (arr, p) => { const a = arr.filter((v) => v != null).sort((x, y) => x - y); return a.length ? a[Math.floor(p * (a.length - 1))] : null; };
for (const id of ids) {
  let raw; try { raw = JSON.parse(gunzipSync(readFileSync(`data-raw/ov/${id}.json.gz`))); } catch { continue; }
  const c = raw.centre;
  const layers = { pois: raw.places.map(([x, y, k]) => ({ lat: y, lon: x, cat: CATS[k] })), stops: raw.stops.map(([x, y, kind]) => ({ lat: y, lon: x, kind })),
    intersections: raw.inter.map(([x, y]) => [y, x]), ped: { ways: raw.ped.map(([x, y, l]) => [y, x, l]), crossings: raw.crossings.map(([x, y]) => [y, x]) },
    geo: { motorways: raw.motorways, trunks: raw.trunks, parks: raw.parks } };
  const sc = new Scorer(layers, c.lat, c.lon);
  const proj = sc.proj;
  const all = new Grid(300); for (const p of layers.pois) all.add(proj.x(p.lon), proj.y(p.lat), 1);
  const rows = [];
  for (let q = -14; q <= 14; q += 2) for (let r = -28; r <= 28; r += 2) {
    const [x, y] = hexCenter(q, r); if (x * x + y * y > 8000 ** 2) continue;
    const lat = proj.lat(y), lon = proj.lon(x);
    const pd = await popDensity(lat, lon); if (pd < 1500) continue;
    const s = sc.scoreAt(lat, lon);
    rows.push({ dens: s.density, ped: s.pedLen, cross: s.nCross, t: s.tSum, n600: all.count(x, y, 600), needs: s.needs, food800: s.perCat.food.within, groc: s.perCat.grocery.within });
  }
  const f = (k) => [0.1, 0.5, 0.9].map((p) => Math.round(pct(rows.map((r) => r[k]), p) * 100) / 100).join('/');
  console.log(raw.name.padEnd(14), 'n', rows.length, '| inter/km2', f('dens'), '| pedLen', f('ped'), '| cross', f('cross'), '| transitSum', f('t'), '| POIs<600m', f('n600'), '| food<800', f('food800'), '| groc<800', f('groc'));
}
