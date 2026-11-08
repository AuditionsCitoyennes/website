// The plateau's DEM tile, rendered without the server: a port of the API's
// renderer (apps/api's modules/dem, deleted in #177; its tiles live on as
// scripts/parity/demRelief.golden.json). The same scanline
// rasteriser at pixel centres with a PAD of 5 texels, the same 2.5-texel
// two-pass chamfer erosion and hard step, the same Mapbox terrain-RGB: ground
// at 0 m, the plateau at the selection's height, nothing in between. Pure: no
// DOM, no Vue; `encodePNG` and `demKey` use only the web globals a worker has
// (CompressionStream when present, crypto.subtle). Not wired into the map yet.
//
// What is proven (scripts/parity/demRelief.test.ts): the tiles are identical,
// texel for texel, to the server's under V8 (Node, and Chrome measured
// headless), and their hashes are kept as a golden file that outlives the API
// module. On other engines the same algorithm may differ by single edge
// texels if `Math.sin`/`Math.log` differ by an ulp.

import { ERODE_TEXELS, PAD, SIZE, type Polygon } from "./demGeometry";

// The light half lives in demGeometry.ts (the main thread imports it without
// the renderer); re-exported so the renderer's callers need one module.
export {
  ERODE_TEXELS,
  PAD,
  RENDER_REV,
  SIZE,
  demKey,
  keyJson,
  polysOf,
  tileTouches,
  type Polygon,
  type Ring,
} from "./demGeometry";

/** A selection held for rendering: its rings projected once to unit Web Mercator. */
export interface DemSelection {
  /** Per polygon, each ring as interleaved [u0, v0, u1, v1, ...]. */
  polys: Float64Array[][];
  /** Per polygon, its box: [minU, minV, maxU, maxV]. */
  pboxes: Float64Array;
  /** The whole selection's box, unit Web Mercator (±Infinity when empty). */
  bbox: [number, number, number, number];
  /** Metres, unrounded: the server encodes the first-posted height as sent. */
  height: number;
}

/** Project once. A tile's pixel is then u * worldSize, bit-identical to the
 *  server's ((lng + 180) / 360) * worldSize: the same operations in the same order. */
export function makeSelection(polys: Polygon[], height: number): DemSelection {
  const out: Float64Array[][] = [];
  const pboxes = new Float64Array(polys.length * 4);
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  polys.forEach((poly, pi) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const rings: Float64Array[] = [];
    for (const ring of poly) {
      const a = new Float64Array(ring.length * 2);
      for (let i = 0; i < ring.length; i++) {
        const lng = ring[i][0];
        const lat = ring[i][1];
        const u = (lng + 180) / 360;
        const s = Math.sin((lat * Math.PI) / 180);
        const v = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
        a[i * 2] = u;
        a[i * 2 + 1] = v;
        if (u < x0) x0 = u;
        if (u > x1) x1 = u;
        if (v < y0) y0 = v;
        if (v > y1) y1 = v;
      }
      rings.push(a);
    }
    out.push(rings);
    pboxes[pi * 4] = x0;
    pboxes[pi * 4 + 1] = y0;
    pboxes[pi * 4 + 2] = x1;
    pboxes[pi * 4 + 3] = y1;
    bx0 = Math.min(bx0, x0);
    by0 = Math.min(by0, y0);
    bx1 = Math.max(bx1, x1);
    by1 = Math.max(by1, y1);
  });
  return { polys: out, pboxes, bbox: [bx0, by0, bx1, by1], height };
}

// Mapbox terrain-RGB encoding: height = -10000 + (R*65536 + G*256 + B) * 0.1.
export function encodeHeight(h: number): [number, number, number] {
  const v = Math.round((h + 10000) * 10);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// The selection's inside/outside mask of (SIZE + 2·pad)² texels for one tile:
// even-odd across the rings of one polygon, the polygons OR-ed. Exported for
// the tests: the box cull must leave the mask itself unchanged, not only the
// eroded tile.
export function rasterizeMask(
  sel: DemSelection,
  z: number,
  x: number,
  y: number,
  pad: number,
  cull: boolean,
): Uint8Array {
  const worldSize = SIZE * Math.pow(2, z);
  const originX = x * SIZE;
  const originY = y * SIZE;
  const W = SIZE + 2 * pad;
  const inside = new Uint8Array(W * W);
  for (let pi = 0; pi < sel.polys.length; pi++) {
    // A polygon whose box misses the padded tile by more than a texel only
    // has spans that clamp to nothing: skipping it changes no texel.
    if (cull) {
      const px0 = sel.pboxes[pi * 4] * worldSize - originX + pad;
      const py0 = sel.pboxes[pi * 4 + 1] * worldSize - originY + pad;
      const px1 = sel.pboxes[pi * 4 + 2] * worldSize - originX + pad;
      const py1 = sel.pboxes[pi * 4 + 3] * worldSize - originY + pad;
      if (px1 < -1 || py1 < -1 || px0 > W + 1 || py0 > W + 1) continue;
    }
    // Only the edges spanning some of this tile's rows can cross its scanlines.
    const ex1: number[] = [];
    const ey1: number[] = [];
    const ex2: number[] = [];
    const ey2: number[] = [];
    for (const ring of sel.polys[pi]) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const y1 = ring[j * 2 + 1] * worldSize - originY + pad;
        const y2 = ring[i * 2 + 1] * worldSize - originY + pad;
        if ((y1 < 0 && y2 < 0) || (y1 > W && y2 > W)) continue;
        ex1.push(ring[j * 2] * worldSize - originX + pad);
        ey1.push(y1);
        ex2.push(ring[i * 2] * worldSize - originX + pad);
        ey2.push(y2);
      }
    }
    for (let py = 0; py < W; py++) {
      const yc = py + 0.5;
      const xs: number[] = [];
      for (let k = 0; k < ey1.length; k++) {
        const y1 = ey1[k];
        const y2 = ey2[k];
        if (y1 <= yc !== y2 <= yc) {
          xs.push(ex1[k] + ((yc - y1) / (y2 - y1)) * (ex2[k] - ex1[k]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.ceil(xs[i] - 0.5));
        const xb = Math.min(W - 1, Math.floor(xs[i + 1] - 0.5));
        for (let px = xa; px <= xb; px++) inside[py * W + px] = 1;
      }
    }
  }
  return inside;
}

export interface DemTile {
  /** 256x256 RGB8. */
  rgb: Uint8Array<ArrayBuffer>;
  /** Every texel the same: "ground" or "plateau" (a shareable tile), else null. */
  constant: "ground" | "plateau" | null;
  msRaster: number;
}

/**
 * The server's renderTile, minus the PNG: eroded-inside texels at the full
 * height, every other one at 0, so the wall is a one-texel step at any zoom.
 * Any z/x/y gets a tile, far outside the selection included. `cull` is for
 * the tests (the box cull on and off must render the same bytes).
 */
export function renderDemTile(
  sel: DemSelection,
  z: number,
  x: number,
  y: number,
  cull = true,
): DemTile {
  const t0 = performance.now();
  const W = SIZE + 2 * PAD;
  const inside = rasterizeMask(sel, z, x, y, PAD, cull);
  // Distance (texels) from each inside texel to the outside: 2-pass chamfer.
  const dist = new Float64Array(W * W);
  for (let i = 0; i < W * W; i++) dist[i] = inside[i] ? 1e9 : 0;
  const SQRT2 = Math.SQRT2;
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (px > 0) d = Math.min(d, dist[i - 1] + 1);
      if (py > 0) d = Math.min(d, dist[i - W] + 1);
      if (px > 0 && py > 0) d = Math.min(d, dist[i - W - 1] + SQRT2);
      if (px < W - 1 && py > 0) d = Math.min(d, dist[i - W + 1] + SQRT2);
      dist[i] = d;
    }
  }
  for (let py = W - 1; py >= 0; py--) {
    for (let px = W - 1; px >= 0; px--) {
      const i = py * W + px;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (px < W - 1) d = Math.min(d, dist[i + 1] + 1);
      if (py < W - 1) d = Math.min(d, dist[i + W] + 1);
      if (px < W - 1 && py < W - 1) d = Math.min(d, dist[i + W + 1] + SQRT2);
      if (px > 0 && py < W - 1) d = Math.min(d, dist[i + W - 1] + SQRT2);
      dist[i] = d;
    }
  }
  const ground = encodeHeight(0);
  const plateau = encodeHeight(sel.height);
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  let nPlateau = 0;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const up = dist[(py + PAD) * W + (px + PAD)] > ERODE_TEXELS;
      if (up) nPlateau++;
      const c = up ? plateau : ground;
      const o = (py * SIZE + px) * 3;
      rgb[o] = c[0];
      rgb[o + 1] = c[1];
      rgb[o + 2] = c[2];
    }
  }
  const constant = nPlateau === 0 ? "ground" : nPlateau === SIZE * SIZE ? "plateau" : null;
  return { rgb, constant, msRaster: performance.now() - t0 };
}

/** A tile of one height everywhere. */
export function constantRgb(h: number): Uint8Array<ArrayBuffer> {
  const c = encodeHeight(h);
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  return rgb;
}

// ---- minimal PNG writer (truecolour RGB, 8-bit), the port of png.ts ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib (RFC 1950): CompressionStream("deflate") is exactly that format. */
async function streamDeflate(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * zlib (RFC 1950) with no compression, for engines without CompressionStream:
 * the header, stored blocks of at most 65,535 bytes, the Adler-32. A tile's
 * 196,864 raw bytes make a ~197 KB PNG instead of ~1 KB, still a valid one.
 */
export function zlibStored(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + 5 * blocks + raw.length + 4);
  out[0] = 0x78; // deflate, 32 KiB window
  out[1] = 0x01; // no dictionary, fastest; (0x78 << 8 | 0x01) % 31 === 0
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const len = Math.min(MAX, raw.length - b * MAX);
    out[o] = b === blocks - 1 ? 1 : 0; // BFINAL, BTYPE 00 (stored)
    out[o + 1] = len & 0xff;
    out[o + 2] = len >>> 8;
    out[o + 3] = ~len & 0xff;
    out[o + 4] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(b * MAX, b * MAX + len), o + 5);
    o += 5 + len;
  }
  let a = 1;
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    s = (s + a) % 65521;
  }
  new DataView(out.buffer).setUint32(o, ((s << 16) | a) >>> 0);
  return out;
}

/**
 * The tile as a PNG. `deflate` defaults, at call time, to CompressionStream
 * where the engine has it and to `zlibStored` where it does not.
 */
export async function encodePNG(
  pixels: Uint8Array,
  w: number,
  h: number,
  deflate?: (raw: Uint8Array<ArrayBuffer>) => Promise<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  const stride = w * 3;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const zlib = deflate ?? (typeof CompressionStream === "function" ? streamDeflate : zlibStored);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A PNG as a data: URL. Built in 32 KiB slices: a stored-block tile is ~197 KB. */
export function pngDataUrl(png: Uint8Array): string {
  let s = "";
  for (let i = 0; i < png.length; i += 0x8000) {
    s += String.fromCharCode(...png.subarray(i, i + 0x8000));
  }
  return "data:image/png;base64," + btoa(s);
}
