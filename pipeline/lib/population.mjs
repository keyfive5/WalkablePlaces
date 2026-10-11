// GHSL 2025 residential population (30 arc-second ≈ 1 km grid, CC BY 4.0).
// Tiles are 10°×10°, downloaded on demand and cached under data-raw/ghsl/pop/.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readGeoTiff } from './geotiff.mjs';

const DIR = new URL('../../data-raw/ghsl/pop/', import.meta.url);
const BASE = 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_30ss/V1-0/tiles/';
const NAME = (r, c) => `GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0_R${r}_C${c}`;
mkdirSync(DIR, { recursive: true });

/** Extract one file from a zip archive (stored or deflated, no ZIP64). */
function unzipEntry(buf, suffix) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (name.endsWith(suffix)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

const tiles = new Map();
async function loadTile(r, c) {
  const key = `${r}_${c}`;
  if (tiles.has(key)) return tiles.get(key);
  const tif = new URL(NAME(r, c) + '.tif', DIR);
  const missing = new URL(NAME(r, c) + '.missing', DIR);
  let tile = null;
  for (let attempt = 1; !existsSync(tif) && !existsSync(missing); attempt++) {
    try {
      const res = await fetch(BASE + NAME(r, c) + '.zip');
      if (res.status === 404) writeFileSync(missing, '');
      else if (!res.ok) throw new Error(`HTTP ${res.status}`);
      else writeFileSync(tif, unzipEntry(Buffer.from(await res.arrayBuffer()), '.tif'));
    } catch (err) {
      if (attempt >= 5) throw new Error(`GHSL tile ${key}: ${err.message}`);
      await new Promise((ok) => setTimeout(ok, 3000 * attempt));
    }
  }
  // Decoded tiles are cached as raw float32 so later runs skip the TIFF decode.
  const raw = new URL(NAME(r, c) + '.f32', DIR), meta = new URL(NAME(r, c) + '.f32.json', DIR);
  if (existsSync(raw) && existsSync(meta)) {
    const buf = readFileSync(raw);
    tile = { ...JSON.parse(readFileSync(meta, 'utf8')), data: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) };
  } else if (existsSync(tif)) {
    tile = readGeoTiff(fileURLToPath(tif));
    const { data, ...head } = tile;
    writeFileSync(raw, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    writeFileSync(meta, JSON.stringify(head));
  }
  tiles.set(key, tile);
  return tile;
}

/** Residents per km² at a point (0 over water / outside the data). */
export async function popDensity(lat, lon) {
  const c = Math.floor((lon + 180.0079166) / 10) + 1;
  const r = Math.floor((89.0995833 - lat) / 10) + 1;
  const t = await loadTile(r, c);
  if (!t) return 0;
  const px = Math.floor((lon - t.originX) / t.resX), py = Math.floor((t.originY - lat) / t.resY);
  if (px < 0 || py < 0 || px >= t.width || py >= t.height) return 0;
  const v = t.data[py * t.width + px];
  if (!(v > 0)) return 0;
  const cellKm2 = (t.resX * 111.32 * Math.cos((lat * Math.PI) / 180)) * (t.resY * 110.54);
  return v / cellKm2;
}
