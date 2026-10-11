// Minimal GeoTIFF reader — just enough for GHSL population tiles.
// Handles little/big-endian classic TIFF, strips or tiles, no/LZW/Deflate
// compression, horizontal (2) and floating-point (3) predictors.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

export function readGeoTiff(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = buf[0] === 0x49;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const big = u16(2) === 43;
  if (!big && u16(2) !== 42) throw new Error('Not a TIFF');
  const u64 = (o) => Number(dv.getBigUint64(o, le));

  const ifd = big ? u64(8) : u32(4);
  const n = big ? u64(ifd) : u16(ifd);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = big ? ifd + 8 + i * 20 : ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), count = big ? u64(e + 4) : u32(e + 4);
    const size = TYPE_SIZE[type] * count;
    const inline = big ? 8 : 4, valAt = big ? e + 12 : e + 8;
    const off = size <= inline ? valAt : (big ? u64(valAt) : u32(valAt));
    const vals = [];
    for (let k = 0; k < count; k++) {
      const p = off + k * TYPE_SIZE[type];
      switch (type) {
        case 1: case 7: vals.push(buf[p]); break;
        case 2: vals.push(buf[p]); break;
        case 3: vals.push(u16(p)); break;
        case 4: vals.push(u32(p)); break;
        case 11: vals.push(dv.getFloat32(p, le)); break;
        case 12: vals.push(dv.getFloat64(p, le)); break;
        case 16: vals.push(Number(dv.getBigUint64(p, le))); break;
        default: vals.push(0);
      }
    }
    tags[tag] = type === 2 ? String.fromCharCode(...vals).replace(/\0+$/, '') : vals;
  }

  const width = tags[256][0], height = tags[257][0];
  const bps = tags[258]?.[0] ?? 8;
  const compression = tags[259]?.[0] ?? 1;
  const predictor = tags[317]?.[0] ?? 1;
  const sampleFormat = tags[339]?.[0] ?? 1;
  const tiled = !!tags[322];
  const bw = tiled ? tags[322][0] : width;
  const bh = tiled ? tags[323][0] : (tags[278]?.[0] ?? height);
  const offsets = tiled ? tags[324] : tags[273];
  const counts = tiled ? tags[325] : tags[279];
  const bytes = bps / 8;

  const out = new Float32Array(width * height);
  const across = Math.ceil(width / bw);
  for (let b = 0; b < offsets.length; b++) {
    let raw = buf.subarray(offsets[b], offsets[b] + counts[b]);
    if (compression === 8 || compression === 32946) raw = inflateSync(raw);
    else if (compression === 5) raw = lzwDecode(raw, bw * bh * bytes);
    else if (compression !== 1) throw new Error('Unsupported compression ' + compression);
    const block = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const rowsInBlock = tiled ? bh : Math.min(bh, height - b * bh);
    if (predictor === 3) unpredictFloat(block, bw, rowsInBlock, bytes);
    const bd = new DataView(block.buffer);
    const read = (i) => {
      const p = i * bytes;
      if (sampleFormat === 3) return bytes === 4 ? bd.getFloat32(p, le) : bd.getFloat64(p, le);
      if (bytes === 1) return block[p];
      if (bytes === 2) return sampleFormat === 2 ? bd.getInt16(p, le) : bd.getUint16(p, le);
      return sampleFormat === 2 ? bd.getInt32(p, le) : bd.getUint32(p, le);
    };
    const x0 = tiled ? (b % across) * bw : 0;
    const y0 = tiled ? Math.floor(b / across) * bh : b * bh;
    for (let y = 0; y < rowsInBlock; y++) {
      let acc = 0;
      for (let x = 0; x < bw; x++) {
        let v = read(y * bw + x);
        if (predictor === 2) { acc += v; v = acc; }
        const gx = x0 + x, gy = y0 + y;
        if (gx < width && gy < height) out[gy * width + gx] = v;
      }
    }
  }

  const scale = tags[33550], tie = tags[33922];
  const nodata = tags[42113] != null ? Number(tags[42113]) : null;
  return {
    width, height, data: out, nodata,
    // pixel (0,0) top-left corner in model space
    originX: tie[3] - tie[0] * scale[0],
    originY: tie[4] + tie[1] * scale[1],
    resX: scale[0], resY: scale[1],
  };
}

// Floating-point predictor: bytes are split into planes then byte-differenced.
function unpredictFloat(block, w, h, bytes) {
  const rowLen = w * bytes;
  const tmp = new Uint8Array(rowLen);
  for (let y = 0; y < h; y++) {
    const row = block.subarray(y * rowLen, (y + 1) * rowLen);
    for (let i = 1; i < rowLen; i++) row[i] = (row[i] + row[i - 1]) & 0xff;
    tmp.set(row);
    for (let x = 0; x < w; x++)
      for (let b = 0; b < bytes; b++)
        // planes are stored most-significant byte first; output little-endian
        row[x * bytes + b] = tmp[(bytes - 1 - b) * w + x];
  }
}

// Table-based TIFF LZW (MSB-first codes, "early change" width switch).
function lzwDecode(input, expected) {
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), len = new Int32Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; len[i] = 1; }
  let next = 258, codeLen = 9, op = 0, prev = -1, bitBuf = 0, bitCnt = 0, ip = 0;
  const write = (code) => {
    const l = len[code];
    if (op + l > expected) return -1;
    for (let k = l - 1, c = code; k >= 0; k--) { out[op + k] = suffix[c]; c = prefix[c]; }
    const first = out[op];
    op += l;
    return first;
  };
  for (;;) {
    while (bitCnt < codeLen && ip < input.length) { bitBuf = ((bitBuf << 8) | input[ip++]) & 0xffffff; bitCnt += 8; }
    if (bitCnt < codeLen) break;
    const code = (bitBuf >>> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
    bitCnt -= codeLen;
    if (code === 257) break;
    if (code === 256) { next = 258; codeLen = 9; prev = -1; continue; }
    let first;
    if (code < next) {
      first = write(code);
      if (first < 0) break;
    } else {
      // KwKwK: the code being defined right now = prev string + its first byte
      if (prev < 0) break;
      first = write(prev);
      if (first < 0 || op >= expected) break;
      out[op++] = first;
    }
    if (prev >= 0 && next < 4096) { prefix[next] = prev; suffix[next] = first; len[next] = len[prev] + 1; next++; }
    prev = code;
    if (next >= 2047) codeLen = 12;
    else if (next >= 1023) codeLen = 11;
    else if (next >= 511) codeLen = 10;
  }
  return Buffer.from(out.buffer, 0, expected);
}
