#!/usr/bin/env node
/**
 * Generates the SnapScribe extension icons (16/32/48/128 px) as PNG files.
 *
 * Zero-dependency: hand-rolls a minimal PNG encoder (IHDR/IDAT/IEND chunks)
 * on top of Node's zlib, and draws a "capture aperture" glyph — an indigo
 * rounded square with a white ring and a cyan center dot — normalized per
 * pixel so it stays legible at every size.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => Math.round(a + (b - a) * t);

// CRC-32 (IEEE 802.3), as required by the PNG spec.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** Returns an RGBA pixel for normalized coordinates (nx, ny) in [0, 1]. */
function pixelAt(x, y, size) {
  const nx = (x + 0.5) / size;
  const ny = (y + 0.5) / size;
  const aa = 1.5 / size;

  // Background: rounded square with an indigo vertical gradient.
  const radius = 0.22;
  const half = 0.5 - radius;
  const qx = Math.max(Math.abs(nx - 0.5) - half, 0);
  const qy = Math.max(Math.abs(ny - 0.5) - half, 0);
  const bgCoverage = 1 - smoothstep(radius - aa, radius + aa, Math.hypot(qx, qy));

  // Aperture: white ring + cyan center dot, both anti-aliased.
  const d = Math.hypot(nx - 0.5, ny - 0.5);
  const ring = smoothstep(0.2 - aa, 0.2 + aa, d) * (1 - smoothstep(0.34 - aa, 0.34 + aa, d));
  const dot = 1 - smoothstep(0.085 - aa, 0.085 + aa, d);

  let r = mix(0x63, 0x43, ny);
  let g = mix(0x66, 0x38, ny);
  let b = mix(0xf1, 0xca, ny);
  r = mix(r, 255, ring);
  g = mix(g, 255, ring);
  b = mix(b, 255, ring);
  r = mix(r, 0x22, dot);
  g = mix(g, 0xd3, dot);
  b = mix(b, 0xee, dot);

  return [r, g, b, Math.round(bgCoverage * 255)];
}

function encodePng(size, pixelFn) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const path = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(path, encodePng(size, pixelAt));
  console.log(`wrote ${path}`);
}
