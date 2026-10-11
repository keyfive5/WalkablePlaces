// The WalkablePlaces scoring model. One file, used by the data pipeline and by
// live scoring in the browser, so every score on the map is computed the same way.
//
//   score = 100 × (0.50·Needs + 0.20·Grid + 0.15·Transit + 0.15·Car-free) × (0.8 + 0.2·Calm)
//
// Needs     daily destinations: how close the nearest ones are (access) and how
//           many there are within a 10-minute walk (abundance)
// Grid      street-network junctions per km² within 500 m — a fine grid means short, direct walks
// Transit   rail, metro, tram, ferry and bus stops within 800 m
// Car-free  length of pedestrian streets, footpaths and steps within 500 m
// Calm      distance from motorways and trunk roads — a multiplier, highways cost up to 20%
//
// Thresholds were set from the observed spread across 15 large cities on four
// continents, so 100 means "as good as the best places on Earth", not "adequate".

export const MODEL_VERSION = 2;

export const WEIGHTS = { needs: 0.50, grid: 0.20, transit: 0.15, ped: 0.15 };

// Per category: how much the 1st, 2nd, 3rd… nearest destination is worth (diminishing returns),
// and how many within 800 m count as "plenty".
export const NEEDS = {
  grocery: [3],
  food: [0.75, 0.45, 0.25, 0.25, 0.225, 0.225, 0.225, 0.225, 0.2, 0.2],
  shops: [0.5, 0.45, 0.4, 0.35, 0.3],
  health: [1, 0.5],
  education: [1, 0.5],
  parks: [1, 0.5],
  errands: [0.6, 0.4],
  culture: [0.5, 0.3, 0.2],
};
export const PLENTY = { grocery: 40, food: 250, shops: 250, health: 40, education: 25, parks: 15, errands: 60, culture: 40 };
const CAT_WEIGHT = Object.fromEntries(Object.entries(NEEDS).map(([c, w]) => [c, w.reduce((a, b) => a + b, 0)]));
const NEEDS_TOTAL = Object.values(CAT_WEIGHT).reduce((a, b) => a + b, 0);

export const CATEGORY_LABELS = {
  grocery: 'Groceries', food: 'Restaurants & cafés', shops: 'Shops', health: 'Health & pharmacy',
  education: 'Schools & childcare', parks: 'Parks & play', errands: 'Banks & services', culture: 'Culture, faith & fitness',
};

export const TRANSIT_WEIGHT = { metro: 3, rail: 3, ferry: 2, tram: 1.5, bus: 1 };

export const PARAMS = {
  fullCredit: 250,      // m: destinations this close count fully (~3 min walk)
  decayScale: 600,      // m: Gaussian fall-off beyond that (a 10-min walk ≈ 44%)
  needsRadius: 1600,    // m: nothing further counts
  plentyRadius: 800,    // m: abundance counts destinations within a 10-min walk
  gridRadius: 500,      // m
  gridLow: 30,          // junctions/km² scoring 0 …
  gridHigh: 320,        // … and 100 (log scale between)
  transitRadius: 800,
  transitFull: 250,
  transitSat: 18,       // weighted stops for ~63%
  pedRadius: 500,
  pedLenFull: 12000,    // m of car-free way within 500 m for full credit
  motorwayClear: 500,   // m from a motorway for no penalty
  trunkClear: 300,
};

export const SUBSCORES = [
  { key: 'needs', label: 'Daily needs', hint: 'Shops, food, schools, health and parks nearby' },
  { key: 'grid', label: 'Street grid', hint: 'Junctions per km² — short, direct routes' },
  { key: 'transit', label: 'Transit', hint: 'Rail, metro, tram, ferry and bus stops within 800 m' },
  { key: 'ped', label: 'Car-free ways', hint: 'Pedestrian streets, paths and steps within 500 m' },
  { key: 'calm', label: 'Highway calm', hint: '100 = no motorway or trunk road close by' },
];

export const TIERS = [
  { min: 85, label: 'Walker’s haven', color: '#2dd4bf' },
  { min: 70, label: 'Very walkable', color: '#4ade80' },
  { min: 50, label: 'Walkable', color: '#facc15' },
  { min: 30, label: 'Car-leaning', color: '#fb923c' },
  { min: 0, label: 'Car-dependent', color: '#f43f5e' },
];
export const tierOf = (s) => TIERS.find((t) => s >= t.min) ?? TIERS[TIERS.length - 1];

/**
 * Combine subscores (each 0–1) into the 0–100 score. When a city's transit stops are
 * essentially unmapped, pass { transit: false }: transit is left out and the other
 * weights rescaled, so missing data isn't scored as missing buses.
 */
export function combine({ needs, grid, transit, ped, calm }, { transit: useTransit = true } = {}) {
  const w = WEIGHTS;
  const base = useTransit
    ? w.needs * needs + w.grid * grid + w.transit * transit + w.ped * ped
    : (w.needs * needs + w.grid * grid + w.ped * ped) / (1 - w.transit);
  return 100 * base * (0.8 + 0.2 * calm);
}

// Below these, a city's map data is too thin to trust (per 1,000 residents in the analysed area).
export const DATA_FLOORS = { destinations: { good: 5, partial: 2 }, stops: 0.15 };
export const dataQuality = (destPer1000) =>
  destPer1000 >= DATA_FLOORS.destinations.good ? 'good' : destPer1000 >= DATA_FLOORS.destinations.partial ? 'partial' : 'limited';

export const decay = (d) => {
  if (d <= PARAMS.fullCredit) return 1;
  const x = (d - PARAMS.fullCredit) / PARAMS.decayScale;
  return Math.exp(-x * x);
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- local projection + spatial grid ------------------------------------------
export class Projection {
  constructor(lat0, lon0) {
    this.lat0 = lat0; this.lon0 = lon0;
    this.kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    this.ky = 110540;
  }
  x(lon) { return (lon - this.lon0) * this.kx; }
  y(lat) { return (lat - this.lat0) * this.ky; }
  lon(x) { return this.lon0 + x / this.kx; }
  lat(y) { return this.lat0 + y / this.ky; }
}

/** Uniform-grid spatial index over projected points. */
export class Grid {
  constructor(cell = 250) { this.cell = cell; this.map = new Map(); this.size = 0; }
  key(i, j) { return i * 100003 + j; }
  add(x, y, item) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let b = this.map.get(k);
    if (!b) this.map.set(k, (b = []));
    b.push(x, y, item);
    this.size++;
  }
  /** Calls fn(dist, item) for every item within r of (x, y). */
  near(x, y, r, fn) {
    const c = this.cell, r2 = r * r;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((y - r) / c), j1 = Math.floor((y + r) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const b = this.map.get(this.key(i, j));
      if (!b) continue;
      for (let k = 0; k < b.length; k += 3) {
        const dx = b[k] - x, dy = b[k + 1] - y, d2 = dx * dx + dy * dy;
        if (d2 <= r2) fn(Math.sqrt(d2), b[k + 2]);
      }
    }
  }
  count(x, y, r) { let n = 0; this.near(x, y, r, () => n++); return n; }
}

/** Merge points closer than `tol` metres (one real intersection often has several OSM nodes). */
export function consolidate(points, proj, tol = 15) {
  const grid = new Grid(tol * 2);
  const kept = [];
  for (const [lat, lon] of points) {
    const x = proj.x(lon), y = proj.y(lat);
    let dup = false;
    grid.near(x, y, tol, () => { dup = true; });
    if (!dup) { grid.add(x, y, 1); kept.push([lat, lon]); }
  }
  return kept;
}

/** Points every `step` metres along a polyline of [lon, lat]. */
function densify(line, proj, step) {
  const out = [];
  for (let i = 0; i < line.length - 1; i++) {
    const ax = proj.x(line[i][0]), ay = proj.y(line[i][1]);
    const bx = proj.x(line[i + 1][0]), by = proj.y(line[i + 1][1]);
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  if (line.length) { const l = line[line.length - 1]; out.push([proj.x(l[0]), proj.y(l[1])]); }
  return out;
}

/**
 * Scorer: build once for an area from parsed OSM layers, then score any point in it.
 * layers = { pois, stops, intersections, ped: {ways}, geo: {motorways, trunks, parks} }
 */
export class Scorer {
  constructor(layers, lat0, lon0) {
    const proj = (this.proj = new Projection(lat0, lon0));
    this.cats = {};
    for (const cat of Object.keys(NEEDS)) this.cats[cat] = new Grid(300);
    let poiId = 0;
    for (const p of layers.pois) this.cats[p.cat]?.add(proj.x(p.lon), proj.y(p.lat), { id: poiId++, ...p });
    // Parks: sample each boundary every 100 m; one park = one destination.
    let parkId = 0;
    for (const park of layers.geo?.parks ?? []) {
      const id = 'park' + parkId++;
      for (const ring of park.rings) for (const [x, y] of densify(ring, proj, 100)) {
        this.cats.parks.add(x, y, { id, cat: 'parks', name: park.name, tag: 'park', lat: proj.lat(y), lon: proj.lon(x) });
      }
    }
    this.stops = new Grid(300);
    const seen = { rail: new Grid(150), tram: new Grid(50), bus: new Grid(50), ferry: new Grid(100) };
    const DEDUPE = { rail: 150, tram: 25, bus: 25, ferry: 50 };
    for (const s of layers.stops) {
      const x = proj.x(s.lon), y = proj.y(s.lat);
      // one station or stop is often mapped as several objects (node, platform, area)
      const k = s.kind === 'metro' || s.kind === 'rail' ? 'rail' : s.kind;
      if (seen[k].count(x, y, DEDUPE[k])) continue;
      seen[k].add(x, y, 1);
      this.stops.add(x, y, s);
    }
    this.inter = new Grid(250);
    for (const [lat, lon] of consolidate(layers.intersections, proj)) this.inter.add(proj.x(lon), proj.y(lat), 1);
    this.pedWays = new Grid(250);
    for (const [lat, lon, len] of layers.ped?.ways ?? []) this.pedWays.add(proj.x(lon), proj.y(lat), len);
    this.motorways = new Grid(300);
    for (const line of layers.geo?.motorways ?? []) for (const [x, y] of densify(line, proj, 40)) this.motorways.add(x, y, 1);
    this.trunks = new Grid(300);
    for (const line of layers.geo?.trunks ?? []) for (const [x, y] of densify(line, proj, 40)) this.trunks.add(x, y, 1);
  }

  /** Full breakdown at a point. With `detail`, also returns the nearest destinations per category. */
  scoreAt(lat, lon, { detail = false } = {}) {
    const P = PARAMS, x = this.proj.x(lon), y = this.proj.y(lat);

    // Needs: 50% access to the nearest few, 50% abundance within 800 m
    let needsSum = 0;
    const perCat = {}, nearest = {};
    for (const [cat, weights] of Object.entries(NEEDS)) {
      // Keep only the K nearest (sorted) and count those within the abundance radius.
      const K = detail ? Math.max(5, weights.length) : weights.length;
      const list = [];
      let within = 0;
      const consider = (d, item) => {
        if (d <= P.plentyRadius) within++;
        if (list.length === K && d >= list[K - 1].d) return;
        let i = list.length;
        if (i === K) { list.pop(); i--; }
        while (i > 0 && list[i - 1].d > d) i--;
        list.splice(i, 0, { d, item });
      };
      if (cat === 'parks') {
        // a park is sampled at many boundary points: count each park once, at its nearest point
        const seen = new Map();
        this.cats.parks.near(x, y, P.needsRadius, (d, item) => {
          const prev = seen.get(item.id);
          if (prev === undefined || d < prev.d) seen.set(item.id, { d, item });
        });
        for (const { d, item } of seen.values()) consider(d, item);
      } else this.cats[cat].near(x, y, P.needsRadius, consider);
      let a = 0;
      for (let i = 0; i < weights.length && i < list.length; i++) a += weights[i] * decay(list[i].d);
      const access = a / CAT_WEIGHT[cat];
      const plenty = Math.sqrt(Math.min(1, within / PLENTY[cat]));
      const score = 0.5 * access + 0.5 * plenty;
      needsSum += score * CAT_WEIGHT[cat];
      perCat[cat] = { score, access, plenty, within, nearestM: list.length ? Math.round(list[0].d) : null };
      if (detail) nearest[cat] = list.slice(0, 5).map((e) => ({ d: Math.round(e.d), name: e.item.name, tag: e.item.tag, lat: e.item.lat, lon: e.item.lon }));
    }
    const needs = needsSum / NEEDS_TOTAL;

    // Grid
    const nInter = this.inter.count(x, y, P.gridRadius);
    const density = nInter / (Math.PI * (P.gridRadius / 1000) ** 2);
    const grid = density <= 0 ? 0 : clamp01(Math.log(density / P.gridLow) / Math.log(P.gridHigh / P.gridLow));

    // Transit
    let tSum = 0;
    const stopList = [];
    this.stops.near(x, y, P.transitRadius, (d, s) => {
      const w = d <= P.transitFull ? 1 : 1 - (d - P.transitFull) / (P.transitRadius - P.transitFull);
      tSum += TRANSIT_WEIGHT[s.kind] * w;
      if (detail) stopList.push({ d: Math.round(d), kind: s.kind, name: s.name, lat: s.lat, lon: s.lon });
    });
    const transit = 1 - Math.exp(-tSum / P.transitSat);

    // Car-free ways
    let pedLen = 0;
    this.pedWays.near(x, y, P.pedRadius, (d, len) => { pedLen += len; });
    const ped = clamp01(pedLen / P.pedLenFull);

    // Calm
    let dMotor = Infinity, dTrunk = Infinity;
    this.motorways.near(x, y, P.motorwayClear, (d) => { if (d < dMotor) dMotor = d; });
    this.trunks.near(x, y, P.trunkClear, (d) => { if (d < dTrunk) dTrunk = d; });
    const qm = dMotor === Infinity ? 1 : clamp01((dMotor - 50) / (P.motorwayClear - 50));
    const qt = dTrunk === Infinity ? 1 : 0.5 + 0.5 * clamp01((dTrunk - 25) / (P.trunkClear - 25));
    const calm = Math.min(qm, qt);

    const score = combine({ needs, grid, transit, ped, calm });

    const out = { score, needs, grid, transit, ped, calm, density, nInter, pedLen, tSum, perCat };
    if (detail) {
      out.nearest = nearest;
      out.stops = stopList.sort((a, b) => a.d - b.d).slice(0, 8);
      out.dMotor = dMotor; out.dTrunk = dTrunk;
    }
    return out;
  }
}

// ---- hex grid (flat-top, axial coordinates, in local metres) -------------------
export const HEX_R = 250; // circumradius in metres
const SQ3 = Math.sqrt(3);
export const hexCenter = (q, r, R = HEX_R) => [R * 1.5 * q, R * SQ3 * (r + q / 2)];
export function hexAt(x, y, R = HEX_R) {
  const qf = (2 / 3) * x / R, rf = (-x / 3 + (SQ3 / 3) * y) / R;
  let q = Math.round(qf), r = Math.round(rf), s = Math.round(-qf - rf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s + qf + rf);
  if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
  return [q, r];
}
/** Hex polygon ring [[lon, lat]...] for axial (q, r); `scale` < 1 shrinks it to leave a gap. */
export function hexRing(q, r, proj, R = HEX_R, scale = 1) {
  const [cx, cy] = hexCenter(q, r, R);
  const ring = [];
  for (let i = 0; i <= 6; i++) {
    const a = (Math.PI / 3) * (i % 6);
    ring.push([proj.lon(cx + R * scale * Math.cos(a)), proj.lat(cy + R * scale * Math.sin(a))]);
  }
  return ring;
}
/** The two corners [[lon, lat], [lon, lat]] of edge k (between vertices k and k+1). */
export function hexEdge(q, r, k, proj, R = HEX_R) {
  const [cx, cy] = hexCenter(q, r, R);
  return [k, k + 1].map((v) => {
    const a = (Math.PI / 3) * (v % 6);
    return [proj.lon(cx + R * Math.cos(a)), proj.lat(cy + R * Math.sin(a))];
  });
}
// Neighbour across edge i, where edge i joins ring vertices i and i+1.
export const HEX_NEIGHBOURS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
export const hexAreaKm2 = (R = HEX_R) => (3 * SQ3 / 2) * (R / 1000) ** 2;
