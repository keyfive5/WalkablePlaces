// OpenStreetMap queries and parsers — shared by the data pipeline (Node) and
// live scoring in the browser, so both measure places exactly the same way.

const f = (v) => v.toFixed(5);
const bb = ({ s, w, n, e }) => `${f(s)},${f(w)},${f(n)},${f(e)}`;

// Streets and paths people can walk on. Sidewalks and crossings mapped as
// separate ways are left out so cities aren't rewarded for mapping detail.
const WALK_NET = '^(primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian|footway|path|steps)$';

const AMENITIES = 'restaurant|cafe|fast_food|pub|bar|food_court|ice_cream|biergarten|marketplace|pharmacy|clinic|doctors|dentist|hospital|school|kindergarten|childcare|college|university|library|bank|post_office|cinema|theatre|community_centre|arts_centre';

/**
 * Overpass queries for an area. `boxes` gives the bbox for each layer:
 * { pois, net, ped, geo } — POIs need the widest margin because people walk to them.
 */
export function buildQueries(boxes, { names = false, timeout = 600 } = {}) {
  const head = (cols, box) => `[out:csv(${cols};false)][timeout:${timeout}][maxsize:2000000000][bbox:${bb(box)}];`;
  const q = {};
  if (boxes.net) q.net = head('::lat,::lon', boxes.net) +
      `(way[highway~"${WALK_NET}"][footway!~"^(sidewalk|crossing)$"][access!~"^(private|no)$"][foot!~"^(no|private)$"];` +
      `way[highway~"${WALK_NET}"][foot~"^(yes|designated|permissive)$"];)->.s;` +
      'node(way_link.s:3-);out skel qt;';
  if (boxes.pois) q.pois = head(`::type,::lat,::lon,amenity,shop,leisure,tourism,highway,railway,station,subway,light_rail${names ? ',name,"name:en"' : ''}`, boxes.pois) +
      '(nwr[shop][shop!~"^(vacant|no|disused)$"];' +
      `nwr[amenity~"^(${AMENITIES})$"];` +
      'nwr[leisure~"^(playground|dog_park|fitness_centre|sports_centre)$"][access!~"^(private|no)$"];' +
      'nwr[tourism~"^(museum|gallery)$"];' +
      'node[highway=bus_stop];' +
      'nwr[railway~"^(station|halt|tram_stop)$"];);out center qt;';
  if (boxes.ped) q.ped = head('::lat,::lon,hw,len', boxes.ped) +
      'way[highway~"^(pedestrian|living_street|footway|steps)$"][footway!~"^(sidewalk|crossing)$"][access!~"^(private|no)$"]->.w;' +
      'node[highway=crossing]->.c;' +
      '.w convert w ::geom=center(geom()),hw=t["highway"],len=length();out geom;' +
      '.c convert n ::geom=geom(),hw="crossing",len=0;out geom;';
  if (boxes.geo) q.geo = `[out:json][timeout:${timeout}][maxsize:2000000000][bbox:${bb(boxes.geo)}];` +
      'way[highway~"^(motorway|trunk)$"][tunnel!~"^(yes|building_passage)$"][covered!=yes]->.h;' +
      '(way[leisure=park];rel[leisure=park];)->.p;' +
      '.h convert w ::geom=geom(),k=t["highway"];out geom;' +
      '.p convert p ::geom=geom(),k="park",n=t["name"];out geom;';
  if (boxes.places) q.places = head('::lat,::lon,place,name,"name:en",population', boxes.places) +
    'node[place~"^(city|town|borough|suburb|quarter|neighbourhood)$"][name];out qt;';
  return q;
}

// ---- categories ---------------------------------------------------------------
const GROCERY = new Set(['supermarket', 'convenience', 'greengrocer', 'grocery', 'food', 'bakery', 'butcher', 'deli',
  'health_food', 'farm', 'seafood', 'cheese', 'dairy', 'frozen_food', 'general', 'pasta', 'spices', 'tea', 'coffee']);
const FOOD = new Set(['restaurant', 'cafe', 'fast_food', 'pub', 'bar', 'food_court', 'ice_cream', 'biergarten']);
const HEALTH = new Set(['pharmacy', 'clinic', 'doctors', 'dentist', 'hospital']);
const EDUCATION = new Set(['school', 'kindergarten', 'childcare', 'college', 'university']);
const ERRANDS = new Set(['bank', 'post_office']);
const CULTURE = new Set(['library', 'cinema', 'theatre', 'community_centre', 'arts_centre']);

export const CATEGORIES = ['grocery', 'food', 'shops', 'health', 'education', 'parks', 'errands', 'culture'];

/** Classify one POI row → { cat } for daily-needs or { transit } for stops, or null. */
export function classify(r) {
  if (r.highway === 'bus_stop') return { transit: 'bus' };
  if (r.railway === 'tram_stop') return { transit: 'tram' };
  if (r.railway === 'station' || r.railway === 'halt') {
    return { transit: r.station === 'subway' || r.subway === 'yes' ? 'metro' : r.station === 'light_rail' || r.light_rail === 'yes' ? 'tram' : 'rail' };
  }
  if (r.amenity) {
    if (r.amenity === 'marketplace') return { cat: 'grocery' };
    if (FOOD.has(r.amenity)) return { cat: 'food' };
    if (HEALTH.has(r.amenity)) return { cat: 'health' };
    if (EDUCATION.has(r.amenity)) return { cat: 'education' };
    if (ERRANDS.has(r.amenity)) return { cat: 'errands' };
    if (CULTURE.has(r.amenity)) return { cat: 'culture' };
  }
  if (r.shop) {
    if (GROCERY.has(r.shop)) return { cat: 'grocery' };
    if (r.shop === 'chemist') return { cat: 'health' };
    return { cat: 'shops' };
  }
  if (r.leisure) return { cat: r.leisure === 'fitness_centre' || r.leisure === 'sports_centre' ? 'culture' : 'parks' };
  if (r.tourism) return { cat: 'culture' };
  return null;
}

const POI_COLS = ['type', 'lat', 'lon', 'amenity', 'shop', 'leisure', 'tourism', 'highway', 'railway', 'station', 'subway', 'light_rail', 'name', 'name_en'];

function rows(text) {
  const out = [];
  for (const line of text.split('\n')) if (line) out.push(line.split('\t'));
  return out;
}

/** POI CSV → { pois: [{lat, lon, cat, name}], stops: [{lat, lon, kind, name}] } */
export function parsePois(text) {
  const pois = [], stops = [];
  for (const cells of rows(text)) {
    const r = {};
    POI_COLS.forEach((k, i) => { if (cells[i]) r[k] = cells[i]; });
    const lat = +r.lat, lon = +r.lon;
    if (!lat && !lon) continue;
    const c = classify(r);
    if (!c) continue;
    const name = r.name_en || r.name || '';
    if (c.transit) stops.push({ lat, lon, kind: c.transit, name });
    else pois.push({ lat, lon, cat: c.cat, name, tag: r.shop || r.amenity || r.leisure || r.tourism });
  }
  return { pois, stops };
}

/** Intersections CSV → [[lat, lon], ...] */
export const parseNet = (text) => rows(text).map(([a, b]) => [+a, +b]).filter(([a, b]) => a || b);

/** Pedestrian ways + crossings CSV → { ways: [[lat, lon, len]], crossings: [[lat, lon]] } */
export function parsePed(text) {
  const ways = [], crossings = [];
  for (const [lat, lon, hw, len] of rows(text)) {
    if (hw === 'crossing') crossings.push([+lat, +lon]);
    else if (hw) ways.push([+lat, +lon, +len || 0]);
  }
  return { ways, crossings };
}

/** Geometry JSON → { motorways: [[[lon,lat]...]], trunks: [...], parks: [{name, rings}] } */
export function parseGeo(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const motorways = [], trunks = [], parks = [];
  for (const el of data.elements || []) {
    const g = el.geometry;
    if (!g) continue;
    const k = el.tags?.k;
    const lines = g.type === 'LineString' ? [g.coordinates]
      : g.type === 'Polygon' ? g.coordinates
      : g.type === 'MultiLineString' ? g.coordinates
      : g.type === 'MultiPolygon' ? g.coordinates.flat()
      : g.type === 'GeometryCollection' ? g.geometries.flatMap((x) => x.type === 'LineString' ? [x.coordinates] : x.type === 'Polygon' ? x.coordinates : [])
      : [];
    if (k === 'motorway') motorways.push(...lines);
    else if (k === 'trunk') trunks.push(...lines);
    else if (k === 'park') parks.push({ name: el.tags?.n || '', rings: lines });
  }
  return { motorways, trunks, parks };
}

/** Places CSV → [{lat, lon, place, name, nameEn, population}] */
export const parsePlaces = (text) => rows(text).map(([lat, lon, place, name, nameEn, population]) =>
  ({ lat: +lat, lon: +lon, place, name, nameEn: nameEn || '', population: parseInt(String(population).replace(/[^\d]/g, ''), 10) || 0 }));
