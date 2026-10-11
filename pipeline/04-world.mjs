// Step 4 — roll city scores up to countries and write the world-level files.
//   docs/data/world.json        countries + every scored city (columnar)
//   docs/data/countries.geojson simplified Natural Earth country shapes
//   docs/data/search.json       neighbourhood names for search
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { SUBSCORES, TIERS } from '../docs/js/model.js';

const DATA = new URL('../docs/data/', import.meta.url);
const catalog = new Map(JSON.parse(readFileSync(new URL('../build/catalog.json', import.meta.url), 'utf8')).map((c) => [c.id, c]));
const r1 = (v) => Math.round(v * 10) / 10;

// ---- country shapes ------------------------------------------------------------
const ne = JSON.parse(readFileSync(new URL('../data-raw/ne/ne_50m_admin_0_countries.geojson', import.meta.url), 'utf8'));
const ISO_FIX = { KOS: 'XKX', SDS: 'SSD', PSX: 'PSE', SAH: 'ESH' };
const isoOf = (p) => ISO_FIX[p.ADM0_A3] || (p.ISO_A3 !== '-99' ? p.ISO_A3 : p.ISO_A3_EH !== '-99' ? p.ISO_A3_EH : p.ADM0_A3);

function simplify(ring, tol) {
  if (ring.length < 5) return ring;
  const keep = new Uint8Array(ring.length);
  const last = ring.length - 1;
  keep[0] = keep[last] = 1;
  // A closed ring starts and ends on the same point: split it at the vertex farthest from the start.
  let far = 1, farD = 0;
  for (let i = 1; i < last; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farD) { farD = d; far = i; }
  }
  keep[far] = 1;
  const stack = [[0, far], [far, last]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * ring[i][0] - dx * ring[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return ring.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}
const simplifyGeom = (g) => {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const out = polys.map((p) => p.map((r) => simplify(r, 0.015)).filter((r) => r.length >= 4)).filter((p) => p.length);
  return { type: 'MultiPolygon', coordinates: out };
};
const countryMeta = new Map();
const shapes = {
  type: 'FeatureCollection',
  features: ne.features.map((f) => {
    const p = f.properties, iso3 = isoOf(p);
    countryMeta.set(iso3, { name: p.NAME || p.NAME_EN, iso2: [p.ISO_A2_EH, p.ISO_A2, p.WB_A2].find((v) => v && v !== '-99') || null, continent: p.CONTINENT, subregion: p.SUBREGION, label: [p.LABEL_X, p.LABEL_Y], bbox: f.bbox });
    return { type: 'Feature', properties: { iso3, name: p.NAME || p.NAME_EN }, geometry: simplifyGeom(f.geometry) };
  }),
};

// ---- cities ---------------------------------------------------------------------
const cityFiles = readdirSync(new URL('city/', DATA)).filter((f) => f.endsWith('.json'));
const cities = [];
const search = [];
for (const f of cityFiles) {
  const c = JSON.parse(readFileSync(new URL('city/' + f, DATA), 'utf8'));
  const cat = catalog.get(c.parentId ?? c.id);
  const s = c.summary;
  const units = [...c.units].map((u, i) => ({ ...u, i })).sort((a, b) => b.score - a.score);
  cities.push({
    id: c.id, name: c.name, iso3: c.iso3, lon: c.centre[0], lat: c.centre[1],
    // GHSL population for the whole urban centre; extra centres use the residents in their analysed area
    pop: c.parentId ? s.pop : (cat?.pop ?? s.pop),
    analysedPop: s.pop, score: s.score, subs: SUBSCORES.map((k) => s[k.key]),
    walkShare: r1(s.tiers[0] + s.tiers[1]), units: c.units.length,
    best: units[0] ? [units[0].name, units[0].score] : null,
    capital: !!cat?.capital, parentId: c.parentId ?? null,
    data: c.data.quality === 'good' ? 0 : c.data.quality === 'partial' ? 1 : 2, transit: c.data.transitMapped ? 1 : 0,
  });
  // [name, cityId, unit index, score, hexes, residents, data quality, town]
  c.units.forEach((u, i) => search.push([u.name, c.id, i, r1(u.score), u.hexes, u.pop, c.data.quality === 'good' ? 0 : c.data.quality === 'partial' ? 1 : 2, u.town && u.town !== c.name ? u.town : 0]));
}
cities.sort((a, b) => b.pop - a.pop);

// ---- countries -------------------------------------------------------------------
const urbanPop = new Map();
for (const c of catalog.values()) urbanPop.set(c.iso3, (urbanPop.get(c.iso3) || 0) + c.pop);
const countries = {};
for (const iso3 of new Set(cities.map((c) => c.iso3))) {
  const cs = cities.filter((c) => c.iso3 === iso3 && !c.parentId);
  if (!cs.length) continue;
  const w = cs.reduce((a, c) => a + c.pop, 0);
  const mean = (fn) => cs.reduce((a, c) => a + fn(c) * c.pop, 0) / w;
  const meta = countryMeta.get(iso3) || {};
  countries[iso3] = {
    name: meta.name || catalog.get(cs[0].id)?.country || iso3, iso2: meta.iso2 || null,
    continent: meta.continent || null, subregion: meta.subregion || null,
    score: r1(mean((c) => c.score)),
    subs: SUBSCORES.map((_, k) => r1(mean((c) => c.subs[k]))),
    walkShare: r1(mean((c) => c.walkShare)),
    cities: cs.length, measuredPop: w, urbanPop: urbanPop.get(iso3) || w,
    coverage: r1((100 * w) / (urbanPop.get(iso3) || w)),
    // population-weighted data coverage: 0 good … 2 limited
    data: r1(mean((c) => c.data)),
    best: [...cs].sort((a, b) => b.score - a.score).slice(0, 3).map((c) => c.id),
    bbox: meta.bbox || null, label: meta.label || null,
  };
}
// Countries listed in the catalogue but with nothing scored yet still get a name.
const pending = {};
for (const c of catalog.values()) if (!countries[c.iso3] && !pending[c.iso3]) pending[c.iso3] = countryMeta.get(c.iso3)?.name || c.country;

const cols = ['id', 'name', 'iso3', 'lon', 'lat', 'pop', 'analysedPop', 'score', 'subs', 'walkShare', 'units', 'best', 'capital', 'parentId', 'data', 'transit'];
const world = {
  generated: new Date().toISOString().slice(0, 10),
  tiers: TIERS.map((t) => t.min),
  totals: {
    cities: cities.length, countries: Object.keys(countries).length,
    neighbourhoods: search.length, people: cities.filter((c) => !c.parentId).reduce((a, c) => a + c.analysedPop, 0),
    catalogCities: catalog.size,
  },
  countries, pending,
  cities: { cols, rows: cities.map((c) => cols.map((k) => c[k])) },
};
writeFileSync(new URL('world.json', DATA), JSON.stringify(world));
writeFileSync(new URL('countries.geojson', DATA), JSON.stringify(shapes));
writeFileSync(new URL('search.json', DATA), JSON.stringify(search));
console.log(`world: ${cities.length} cities, ${Object.keys(countries).length} countries, ${search.length} neighbourhoods`);
