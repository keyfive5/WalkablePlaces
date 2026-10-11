// Zero-dependency PMTiles v3 reader + Mapbox Vector Tile decoder.
// Works in browsers and Node 18+ (uses fetch with Range requests and DecompressionStream).

// ---- PMTiles -----------------------------------------------------------------
const tzValues = [];
{ let acc = 0; for (let z = 0; z < 27; z++) { tzValues.push(acc); acc += 4 ** z; } }

function rotate(n, xy, rx, ry) {
  if (ry === 0) {
    if (rx === 1) { xy[0] = n - 1 - xy[0]; xy[1] = n - 1 - xy[1]; }
    const t = xy[0]; xy[0] = xy[1]; xy[1] = t;
  }
}
export function zxyToTileId(z, x, y) {
  let d = 0;
  const xy = [x, y];
  for (let s = 2 ** z / 2; s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0, ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(s, xy, rx, ry);
  }
  return tzValues[z] + d;
}

function readVarint(buf, pos) {
  let result = 0, mul = 1, b;
  do { b = buf[pos.i++]; result += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
  return result;
}

async function decompress(bytes, kind) {
  if (kind === 1 || kind === 0) return bytes;
  if (kind !== 2) throw new Error('Unsupported PMTiles compression ' + kind);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseDirectory(buf) {
  const pos = { i: 0 };
  const n = readVarint(buf, pos);
  const entries = new Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last += readVarint(buf, pos); entries[i] = { tileId: last, offset: 0, length: 0, runLength: 1 }; }
  for (let i = 0; i < n; i++) entries[i].runLength = readVarint(buf, pos);
  for (let i = 0; i < n; i++) entries[i].length = readVarint(buf, pos);
  for (let i = 0; i < n; i++) {
    const v = readVarint(buf, pos);
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

function findEntry(entries, tileId) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = tileId - entries[mid].tileId;
    if (c > 0) lo = mid + 1; else if (c < 0) hi = mid - 1; else return entries[mid];
  }
  if (hi >= 0) {
    const e = entries[hi];
    if (e.runLength === 0) return e; // leaf directory
    if (tileId - e.tileId < e.runLength) return e;
  }
  return null;
}

export class PMTiles {
  constructor(url) { this.url = url; this.dirCache = new Map(); }
  async range(offset, length) {
    const res = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!res.ok) throw new Error(`PMTiles HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  header() {
    return (this._header ??= this.range(0, 16384).then((b) => {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const u64 = (o) => Number(dv.getBigUint64(o, true));
      const h = {
        rootOffset: u64(8), rootLength: u64(16), metaOffset: u64(24), metaLength: u64(32),
        leafOffset: u64(40), leafLength: u64(48), dataOffset: u64(56), dataLength: u64(64),
        internalCompression: b[97], tileCompression: b[98], tileType: b[99], minZoom: b[100], maxZoom: b[101],
      };
      h.rootBytes = b.slice(h.rootOffset, h.rootOffset + h.rootLength);
      return h;
    }));
  }
  async directory(offset, length, h) {
    const key = offset + ':' + length;
    if (!this.dirCache.has(key)) {
      this.dirCache.set(key, (async () => {
        const raw = offset === h.rootOffset ? h.rootBytes : await this.range(offset, length);
        return parseDirectory(await decompress(raw, h.internalCompression));
      })());
    }
    return this.dirCache.get(key);
  }
  async metadata() {
    const h = await this.header();
    const raw = await this.range(h.metaOffset, h.metaLength);
    return JSON.parse(new TextDecoder().decode(await decompress(raw, h.internalCompression)));
  }
  /** Raw (decompressed) tile bytes, or null when the tile is absent. */
  async tile(z, x, y) {
    const h = await this.header();
    const id = zxyToTileId(z, x, y);
    let dOff = h.rootOffset, dLen = h.rootLength;
    for (let depth = 0; depth < 4; depth++) {
      const entries = await this.directory(dOff, dLen, h);
      const e = findEntry(entries, id);
      if (!e) return null;
      if (e.runLength > 0) {
        const raw = await this.range(h.dataOffset + e.offset, e.length);
        return decompress(raw, h.tileCompression);
      }
      dOff = h.leafOffset + e.offset; dLen = e.length;
    }
    return null;
  }
}

// ---- Mapbox Vector Tile ------------------------------------------------------
class Pbf {
  constructor(buf) { this.buf = buf; this.pos = 0; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  varint() {
    let r = 0, mul = 1, b;
    do { b = this.buf[this.pos++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return r;
  }
  svarint() { const n = this.varint(); return n % 2 === 1 ? (n + 1) / -2 : n / 2; }
  bytes() { const len = this.varint(); const s = this.buf.subarray(this.pos, this.pos + len); this.pos += len; return s; }
  string() { return new TextDecoder().decode(this.bytes()); }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
  }
  packed() { const end = this.varint() + this.pos; const out = []; while (this.pos < end) out.push(this.varint()); return out; }
}

function readValue(p) {
  const end = p.varint() + p.pos;
  let v = null;
  while (p.pos < end) {
    const tag = p.varint(), field = tag >> 3;
    if (field === 1) v = p.string();
    else if (field === 2) { v = p.dv.getFloat32(p.pos, true); p.pos += 4; }
    else if (field === 3) { v = p.dv.getFloat64(p.pos, true); p.pos += 8; }
    else if (field === 4 || field === 5) v = p.varint();
    else if (field === 6) v = p.svarint();
    else if (field === 7) v = !!p.varint();
    else p.skip(tag & 7);
  }
  return v;
}

function decodeGeometry(cmds) {
  const rings = [];
  let x = 0, y = 0, ring = null, i = 0;
  while (i < cmds.length) {
    const c = cmds[i++], id = c & 7, count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        const dx = cmds[i++], dy = cmds[i++];
        x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
        if (id === 1) { ring = []; rings.push(ring); }
        ring.push([x, y]);
      }
    } else if (id === 7 && ring) ring.push(ring[0]);
  }
  return rings;
}

/**
 * Decode an MVT tile into { layerName: [{ type, props, rings: [[lon, lat]...][] }] }.
 * type: 1 point, 2 line, 3 polygon. Coordinates are converted to lon/lat.
 */
export function decodeTile(bytes, z, tx, ty, wanted = null) {
  const p = new Pbf(bytes);
  const out = {};
  while (p.pos < bytes.length) {
    const tag = p.varint();
    if (tag >> 3 !== 3) { p.skip(tag & 7); continue; }
    const end = p.varint() + p.pos;
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (p.pos < end) {
      const t = p.varint(), field = t >> 3;
      if (field === 1) name = p.string();
      else if (field === 2) {
        const fEnd = p.varint() + p.pos;
        const f = { tags: [], type: 0, geom: [] };
        while (p.pos < fEnd) {
          const ft = p.varint(), ff = ft >> 3;
          if (ff === 2) f.tags = p.packed();
          else if (ff === 3) f.type = p.varint();
          else if (ff === 4) f.geom = p.packed();
          else p.skip(ft & 7);
        }
        feats.push(f);
      } else if (field === 3) keys.push(p.string());
      else if (field === 4) values.push(readValue(p));
      else if (field === 5) extent = p.varint();
      else p.skip(t & 7);
    }
    if (wanted && !wanted.includes(name)) continue;
    const n = 2 ** z;
    const toLon = (px) => ((tx + px / extent) / n) * 360 - 180;
    const toLat = (py) => {
      const yy = Math.PI * (1 - (2 * (ty + py / extent)) / n);
      return (Math.atan(Math.sinh(yy)) * 180) / Math.PI;
    };
    out[name] = feats.map((f) => {
      const props = {};
      for (let i = 0; i < f.tags.length; i += 2) props[keys[f.tags[i]]] = values[f.tags[i + 1]];
      const rings = decodeGeometry(f.geom).map((r) => r.map(([x, y]) => [toLon(x), toLat(y)]));
      return { type: f.type, props, rings, extent };
    });
  }
  return out;
}

export const lonLatToTile = (lon, lat, z) => {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [x, y];
};
