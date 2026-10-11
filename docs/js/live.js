// Live scoring for any point on Earth: reads Overture Maps vector tiles (PMTiles
// on S3) around the point and runs the same model as the precomputed map.
import { PMTiles, decodeTile, lonLatToTile } from './pmtiles.js';
import { Scorer, PARAMS, NEEDS } from './model.js';

const RELEASE = '2026-09-23.1';
const BASE = `https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/${RELEASE}/`;
const sources = {};
const pm = (theme) => (sources[theme] ??= new PMTiles(BASE + theme + '.pmtiles'));

let categoryMap = null;
async function categories() {
  if (!categoryMap) {
    const json = await (await fetch(new URL('../data/categories.json', import.meta.url))).json();
    categoryMap = new Map();
    for (const [cat, list] of Object.entries(json)) if (Array.isArray(list)) for (const oc of list) categoryMap.set(oc, cat);
  }
  return categoryMap;
}

function tilesAround(lat, lon, radiusM, z) {
  const dLat = radiusM / 110540, dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const [x0, y0] = lonLatToTile(lon - dLon, lat + dLat, z);
  const [x1, y1] = lonLatToTile(lon + dLon, lat - dLat, z);
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  return out;
}

const parseJson = (v) => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return null; } };
const flags = (v) => (parseJson(v) || []).flatMap((f) => (f.between ? [] : f.values || []));

function lengthM(line) {
  let m = 0;
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i - 1], [x2, y2] = line[i];
    const kx = 111320 * Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
    m += Math.hypot((x2 - x1) * kx, (y2 - y1) * 110540);
  }
  return m;
}

/**
 * Score a point. onProgress(done, total) reports tile downloads.
 * Returns the full breakdown plus the nearest destinations and stops.
 */
export async function scorePoint(lat, lon, onProgress = () => {}) {
  const cats = await categories();
  const jobs = [
    ...tilesAround(lat, lon, PARAMS.needsRadius, 14).map((t) => ['places', t]),
    ...tilesAround(lat, lon, PARAMS.needsRadius, 13).map((t) => ['base', t]),
    ...tilesAround(lat, lon, Math.max(PARAMS.gridRadius, PARAMS.pedRadius, PARAMS.motorwayClear) + 100, 14).map((t) => ['transportation', t]),
  ];
  let done = 0;
  onProgress(0, jobs.length);
  const results = await Promise.all(jobs.map(async ([theme, [z, x, y]]) => {
    const bytes = await pm(theme).tile(z, x, y);
    onProgress(++done, jobs.length);
    return { theme, layers: bytes ? decodeTile(bytes, z, x, y) : {} };
  }));

  const pois = [], stops = [], parks = [], motorways = [], trunks = [];
  const seenPlace = new Set(), seenPark = new Set();
  const segs = new Map(), connectors = new Map();
  for (const { theme, layers } of results) {
    if (theme === 'places') {
      for (const f of layers.place || []) {
        const p = f.props;
        if (seenPlace.has(p.id) || (p.confidence ?? 0) < 0.5) continue;
        if (p.operating_status && p.operating_status !== 'open') continue;
        const cat = cats.get(p.basic_category);
        if (!cat) continue;
        seenPlace.add(p.id);
        const [lonP, latP] = f.rings[0][0];
        pois.push({ lat: latP, lon: lonP, cat, name: p['@name'] || parseJson(p.names)?.primary || '', tag: p.basic_category });
      }
    } else if (theme === 'base') {
      for (const f of layers.infrastructure || []) {
        const p = f.props;
        if (p.subtype !== 'transit') continue;
        const tags = parseJson(p.source_tags) || {};
        const pts = f.rings.flat();
        const lonP = pts.reduce((a, q) => a + q[0], 0) / pts.length, latP = pts.reduce((a, q) => a + q[1], 0) / pts.length;
        const c = p.class;
        let kind = null;
        if (c === 'bus_stop' || (c === 'platform' && (tags.bus === 'yes' || tags.highway === 'bus_stop'))) kind = 'bus';
        else if (c === 'ferry_terminal' || (c === 'platform' && tags.ferry === 'yes')) kind = 'ferry';
        else if (c === 'subway_station' || tags.station === 'subway') kind = 'metro';
        else if (c === 'railway_station' || c === 'railway_halt') kind = tags.station === 'light_rail' ? 'tram' : 'rail';
        else if ((c === 'stop_position' || c === 'platform') && (tags.railway === 'tram_stop' || tags.tram === 'yes' || tags.light_rail === 'yes')) kind = 'tram';
        if (kind) stops.push({ lat: latP, lon: lonP, kind, name: p['@name'] || '' });
      }
      for (const f of layers.land_use || []) {
        const p = f.props;
        if (p.subtype !== 'park' || !(p.class === 'park' || p.class === 'dog_park')) continue;
        const key = p.id + ':' + f.rings.length + ':' + f.rings[0]?.[0];
        if (seenPark.has(key)) continue;
        seenPark.add(key);
        parks.push({ name: p['@name'] || '', rings: f.rings });
      }
    } else {
      for (const f of layers.connector || []) connectors.set(f.props.id, f.rings[0][0]);
      for (const f of layers.segment || []) {
        const p = f.props;
        if (p.subtype !== 'road') continue;
        const len = f.rings.reduce((a, r) => a + lengthM(r), 0);
        const prev = segs.get(p.id);
        if (!prev || len > prev.len) segs.set(p.id, { p, rings: f.rings, len });
      }
    }
  }

  // Walk-network junctions: connectors where 3+ walkable segment ends meet.
  const WALK = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian', 'footway', 'path', 'steps', 'service']);
  const SKIP_SUB = new Set(['sidewalk', 'crosswalk', 'parking_aisle', 'driveway', 'cycle_crossing']);
  const degree = new Map();
  const pedWays = [];
  for (const { p, rings, len } of segs.values()) {
    const rf = flags(p.road_flags);
    const isLink = rf.includes('is_link') || p.subclass === 'link';
    if (p.class === 'motorway' || p.class === 'trunk') {
      if (!isLink && !rf.includes('is_tunnel')) (p.class === 'motorway' ? motorways : trunks).push(...rings);
      continue;
    }
    if (!WALK.has(p.class) || isLink || SKIP_SUB.has(p.subclass) || (p.class === 'service' && p.subclass !== 'alley')) continue;
    for (const c of parseJson(p.connectors) || []) {
      const end = c.at <= 1e-6 || c.at >= 1 - 1e-6;
      degree.set(c.connector_id, (degree.get(c.connector_id) || 0) + (end ? 1 : 2));
    }
    if (['pedestrian', 'living_street', 'footway', 'steps'].includes(p.class)) {
      const mid = rings[0][Math.floor(rings[0].length / 2)];
      pedWays.push([mid[1], mid[0], len]);
    }
  }
  const intersections = [];
  for (const [id, d] of degree) if (d >= 3 && connectors.has(id)) { const [x, y] = connectors.get(id); intersections.push([y, x]); }

  const scorer = new Scorer({ pois, stops, intersections, ped: { ways: pedWays }, geo: { motorways, trunks, parks } }, lat, lon);
  const result = scorer.scoreAt(lat, lon, { detail: true });
  result.tiles = jobs.length;
  result.counts = { places: pois.length, stops: stops.length, intersections: intersections.length };
  return result;
}

export const NEED_CATS = Object.keys(NEEDS);
