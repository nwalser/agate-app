// Generate a 1024×1024 source PNG for the Agate app icon — a teal gem on a dark
// background — with zero dependencies (raw PNG + zlib). Feed the output to
// `npx tauri icon` to produce the full platform icon set.

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1024;
const H = 1024;

const raw = Buffer.alloc(H * (1 + W * 4)); // one filter byte (0) per scanline

function setPx(x, y, r, g, b, a) {
  const o = y * (1 + W * 4) + 1 + x * 4;
  raw[o] = r;
  raw[o + 1] = g;
  raw[o + 2] = b;
  raw[o + 3] = a;
}

const cx = W / 2;
const cy = H / 2;
const rx = W * 0.3;
const ry = H * 0.36;

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = y / H;
    // Dark vertical gradient background (#1b2b33 → #16161a).
    let r = Math.round(0x16 + (0x1b - 0x16) * (1 - t));
    let g = Math.round(0x16 + (0x2b - 0x16) * (1 - t));
    let b = Math.round(0x1a + (0x33 - 0x1a) * (1 - t));
    const a = 255;

    // Diamond "gem" (L1 ball).
    const d = Math.abs(x - cx) / rx + Math.abs(y - cy) / ry;
    if (d <= 1) {
      const tt = (y - (cy - ry)) / (2 * ry); // 0 top → 1 bottom
      r = Math.round(0x3a + (0x8a - 0x3a) * tt);
      g = Math.round(0xc0 + (0xe0 - 0xc0) * tt);
      b = 0xff;
      if (d > 0.92) {
        // facet/border
        r = 0x20;
        g = 0x90;
        b = 0xc8;
      }
      // central facet seam
      if (Math.abs(x - cx) < 3) {
        r = Math.round(r * 0.7);
        g = Math.round(g * 0.85);
      }
    }
    setPx(x, y, r, g, b, a);
  }
}

// --- minimal PNG encoder ---
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '..', 'src-tauri', 'icons', 'source.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
