// Step 1 — the global city catalogue and the measurement queue.
//
// Inputs (data-raw/):
//   ghsl/GHS_UCDB_THEME_GENERAL_CHARACTERISTICS_GLOBE_R2024A.{csv,gpkg}  GHSL Urban Centre Database R2024A (CC BY 4.0)
//   boeing/indicators.tab   Boeing (2025) street-network indicators — used only for ISO codes + street stats (CC0)
// Outputs (build/):
//   catalog.json  every urban centre on Earth (11k+): id, name, country, centroid, population, area
//   targets.json  cities to measure, in priority order, with their urban-centre polygons
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseCsv, norm } from './lib/util.mjs';
import { mollweideToLonLat, parseGpkgGeometry } from './lib/geo.mjs';
import { CURATED, EXTRA_CENTRES } from './curated.mjs';

const RAW = new URL('../data-raw/', import.meta.url);
const BUILD = new URL('../build/', import.meta.url);
mkdirSync(BUILD, { recursive: true });

const ghslRows = parseCsv(readFileSync(new URL('ghsl/GHS_UCDB_THEME_GENERAL_CHARACTERISTICS_GLOBE_R2024A.csv', RAW), 'utf8'));
const boeing = new Map(parseCsv(readFileSync(new URL('boeing/indicators.tab', RAW), 'utf8')).map((b) => [b.uc_id, b]));
const db = new DatabaseSync(fileURLToPath(new URL('ghsl/GHS_UCDB_THEME_GENERAL_CHARACTERISTICS_GLOBE_R2024A.gpkg', RAW)), { readOnly: true });
// Despite their names, the centroid columns are Mollweide metres (ESRI:54009).
const centroids = new Map(db.prepare('select ID_UC_G0 id, GC_UCC_LON_2025 x, GC_UCC_LAT_2025 y from UC_centroids').all()
  .map((r) => [String(r.id), mollweideToLonLat(r.x, r.y)]));

// Country name → ISO3, learned from rows present in both datasets.
const isoByCountry = new Map();
for (const g of ghslRows) {
  const b = boeing.get(g.ID_UC_G0);
  if (b && !isoByCountry.has(g.GC_CNT_UNN_2025)) isoByCountry.set(g.GC_CNT_UNN_2025, b.country_iso);
}
const MANUAL_ISO = { 'Kosovo': 'XKX', 'Western Sahara': 'ESH', 'Faroe Islands': 'FRO', 'Greenland': 'GRL',
  'Liechtenstein': 'LIE', 'Andorra': 'AND', 'San Marino': 'SMR', 'Monaco': 'MCO', 'Holy See': 'VAT',
  'Maldives': 'MDV', 'Bhutan': 'BTN' };

const num = (v) => (v === '' || v == null ? null : Number(v));
const catalog = [];
const missingIso = new Set();
for (const g of ghslRows) {
  const c = centroids.get(g.ID_UC_G0);
  if (!c) continue;
  const b = boeing.get(g.ID_UC_G0);
  const iso3 = b?.country_iso || isoByCountry.get(g.GC_CNT_UNN_2025) || MANUAL_ISO[g.GC_CNT_UNN_2025];
  if (!iso3) { missingIso.add(g.GC_CNT_UNN_2025); continue; }
  catalog.push({
    id: Number(g.ID_UC_G0),
    name: g.GC_UCN_MAI_2025,
    names: g.GC_UCN_LIS_2025.split(';').map((s) => s.trim()).filter(Boolean),
    country: g.GC_CNT_UNN_2025,
    iso3,
    region: g.GC_DEV_USR_2025,
    income: g.GC_DEV_WIG_2025,
    capital: g.GC_UCM_CAP === '1',
    lon: +c[0].toFixed(5), lat: +c[1].toFixed(5),
    pop: Math.round(num(g.GC_POP_TOT_2025)),
    area: num(g.GC_UCA_KM2_2025),
    net: b ? {
      idens: +(num(b.intersect_count_clean) / num(b.area_km2)).toFixed(1),
      p4: +num(b.prop_4way).toFixed(3), pde: +num(b.prop_deadend).toFixed(3),
      circ: +num(b.circuity).toFixed(4), entropy: +num(b.orientation_entropy).toFixed(3),
      grade: +num(b.grade_mean).toFixed(4),
    } : null,
  });
}
if (missingIso.size) console.log('no ISO code for:', [...missingIso].join(', '));
console.log('catalog', catalog.length, 'urban centres in', new Set(catalog.map((c) => c.iso3)).size, 'countries');

// ---- measurement queue ---------------------------------------------------------
const picked = new Map(); // id -> tier
const pick = (c, tier) => { if (c && !picked.has(c.id)) picked.set(c.id, tier); };
const matchName = (name, iso3) => {
  const n = norm(name);
  return catalog.filter((c) => c.iso3 === iso3 && (norm(c.name) === n || c.names.some((x) => norm(x) === n)))
    .sort((a, b) => b.pop - a.pop)[0];
};
const unmatched = [];
for (const [name, iso3] of CURATED) {
  const c = matchName(name, iso3);
  if (!c) unmatched.push(`${name} (${iso3})`);
  pick(c, 0);
}
if (unmatched.length) console.log('unmatched curated:', unmatched.join(', '));

const sorted = [...catalog].sort((a, b) => b.pop - a.pop);
for (const c of sorted) if (c.pop >= 3e6) pick(c, 1);
const largest = new Map();
for (const c of sorted) if (!largest.has(c.iso3)) largest.set(c.iso3, c);
for (const c of largest.values()) pick(c, 2);
for (const c of sorted) if (c.capital) pick(c, 2);
for (const c of sorted) if (c.pop >= 5e5) pick(c, 3);
// Every remaining urban centre, in a space-filling-curve order so neighbours share download blocks.
const hilbert = (lon, lat) => {
  let x = Math.floor(((lon + 180) / 360) * 65535), y = Math.floor(((90 - lat) / 180) * 65535), d = 0;
  for (let s = 32768; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = 65535 - x; y = 65535 - y; } [x, y] = [y, x]; }
  }
  return d;
};
const rest = catalog.filter((c) => !picked.has(c.id)).sort((a, b) => hilbert(a.lon, a.lat) - hilbert(b.lon, b.lat));
for (const c of rest) pick(c, 4);

const geomStmt = db.prepare('select geom from GHSL_UCDB_THEME_GENERAL_CHARACTERISTICS_GLOBE_R2024A where ID_UC_G0 = ?');
const polygonFor = (id) => parseGpkgGeometry(geomStmt.get(id).geom)
  .map((rings) => rings.map((ring) => ring.map(([x, y]) => mollweideToLonLat(x, y).map((v) => +v.toFixed(5)))));

const byId = new Map(catalog.map((c) => [c.id, c]));
const targets = [];
for (const [id, tier] of picked) {
  const c = byId.get(id);
  targets.push({ id, tier, name: c.name, names: c.names, iso3: c.iso3, country: c.country, pop: c.pop, area: c.area,
    lat: c.lat, lon: c.lon, polygon: polygonFor(id) });
}
EXTRA_CENTRES.forEach((x, i) => {
  if (catalog.some((c) => c.iso3 === x.iso3 && norm(c.name) === norm(x.name))) return; // already its own urban centre
  const parent = matchName(x.parent, x.iso3);
  targets.push({ id: 900001 + i, tier: 0, name: x.name, names: [x.name], iso3: x.iso3, country: parent.country, parentId: parent.id,
    pop: null, area: null, lat: x.lat, lon: x.lon, fixedCentre: true, polygon: polygonFor(parent.id) });
});
// Curated keep their hand-picked order; tiers 1–3 by population; tier 4 by the space-filling curve.
const order = new Map(targets.map((t, i) => [t.id, i]));
targets.sort((a, b) => a.tier - b.tier || (a.tier === 0 || a.tier === 4 ? order.get(a.id) - order.get(b.id) : b.pop - a.pop));

writeFileSync(new URL('catalog.json', BUILD), JSON.stringify(catalog));
writeFileSync(new URL('targets.json', BUILD), JSON.stringify(targets));
const tierCount = targets.reduce((m, t) => ((m[t.tier] = (m[t.tier] || 0) + 1), m), {});
console.log('targets', targets.length, 'by tier', tierCount);
