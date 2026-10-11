// Geometry helpers for the pipeline (zero dependencies).

const R_MOLL = 6378137; // ESRI:54009 World_Mollweide on WGS84 semi-major axis
const SQRT2 = Math.SQRT2;

/** Inverse Mollweide (ESRI:54009) → [lon, lat] in degrees. */
export function mollweideToLonLat(x, y) {
  const theta = Math.asin(Math.max(-1, Math.min(1, y / (SQRT2 * R_MOLL))));
  const lat = Math.asin((2 * theta + Math.sin(2 * theta)) / Math.PI);
  const lon = (Math.PI * x) / (2 * SQRT2 * R_MOLL * Math.cos(theta));
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** Parse a GeoPackage geometry blob → array of polygons, each an array of rings of [x, y]. */
export function parseGpkgGeometry(blob) {
  const buf = Buffer.from(blob);
  if (buf[0] !== 0x47 || buf[1] !== 0x50) throw new Error('Not a GPKG geometry');
  const flags = buf[3];
  const envType = (flags >> 1) & 7;
  const envBytes = [0, 32, 48, 48, 64][envType] ?? 0;
  return parseWkb(buf, 8 + envBytes).geom;
}

function parseWkb(buf, off) {
  const le = buf[off] === 1;
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  let type = u32(off + 1);
  let p = off + 5;
  const hasZ = type > 1000 && type < 2000 || (type & 0x80000000) !== 0;
  type = type % 1000 & 0xff;
  const dim = hasZ ? 3 : 2;
  const readPolygon = () => {
    const nr = u32(p); p += 4;
    const rings = [];
    for (let r = 0; r < nr; r++) {
      const np = u32(p); p += 4;
      const ring = new Array(np);
      for (let i = 0; i < np; i++) { ring[i] = [f64(p), f64(p + 8)]; p += 8 * dim; }
      rings.push(ring);
    }
    return rings;
  };
  if (type === 3) return { geom: [readPolygon()], end: p };
  if (type === 6) {
    const n = u32(p); p += 4;
    const polys = [];
    for (let i = 0; i < n; i++) {
      const sub = parseWkb(buf, p);
      polys.push(...sub.geom);
      p = sub.end;
    }
    return { geom: polys, end: p };
  }
  throw new Error('Unsupported WKB type ' + type);
}

/** Even-odd point-in-polygon for one polygon (outer ring + holes). */
export function pointInPolygon(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export const pointInMultiPolygon = (x, y, polys) => polys.some((rings) => pointInPolygon(x, y, rings));

/** Great-circle distance in meters. */
export function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

export function bboxOf(points) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lon, lat] of points) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return { s, w, n, e };
}

/** Expand a bbox by `m` meters on each side. */
export function padBbox({ s, w, n, e }, m) {
  const dLat = m / 110540;
  const dLon = m / (111320 * Math.cos((((s + n) / 2) * Math.PI) / 180));
  return { s: s - dLat, w: w - dLon, n: n + dLat, e: e + dLon };
}
