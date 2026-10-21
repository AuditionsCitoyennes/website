import { createHash } from "node:crypto";
import { encodePNG } from "./png";

// Dynamic terrain-RGB (Mapbox-encoded) DEM tiles that raise a SELECTED set of
// polygons as a flat-topped plateau and leave everything else at ground level.
// Drives the "Plateau" elevation mode: the map drapes over this DEM via setTerrain,
// so the real basemap tiles inside the selection lift up uniformly (no colour).
//
// Pure Node — rasterises the polygons per tile (scanline) and writes a minimal PNG
// (zlib + CRC32), no native image deps.

type Ring = [number, number][];
type Polygon = Ring[]; // [exterior, ...holes]

interface Selection {
  polys: Polygon[];
  height: number; // plateau height in metres
}

const store = new Map<string, Selection>();
const MAX_VERSIONS = 40;

// Folded into every version key. Tiles are served immutable for a year, so a
// client that drilled a territory keeps the tiles it got: bump this whenever
// the bytes rendered for the SAME selection change (encoding, erosion,
// rasteriser), or returning clients stay on the old rendering.
const RENDER_REV = 1;

/** The version key: 128 bits of the selection's hash. (fnv1a's 32 bits made a
 *  collision between two drilled territories a matter of tens of thousands of
 *  selections — and a collision raises one territory's plateau for another.) */
function versionKey(polys: Polygon[], height: number): string {
  return createHash("sha1")
    .update(`${RENDER_REV}\n`)
    .update(JSON.stringify({ polys, height }))
    .digest("hex")
    .slice(0, 32);
}

interface GeoFeatureLike {
  geometry?: { type?: string; coordinates?: unknown };
  type?: string;
  coordinates?: unknown;
}

/** Store the selection's polygons + plateau height; returns a stable version key
 *  (same geometry+height → same key, so Mapbox reuses cached tiles). */
export function setSelection(features: GeoFeatureLike[], height: number): string {
  const polys: Polygon[] = [];
  for (const f of features) {
    const g = (f.geometry ?? f) as { type?: string; coordinates?: unknown };
    if (!g?.type) continue;
    const list = (
      g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
    ) as Polygon[];
    for (const poly of list) polys.push(poly);
  }
  const key = versionKey(polys, Math.round(height));
  // True LRU: a hit refreshes recency (Map preserves insertion order), so a
  // version still being rendered by clients can't age out behind their back.
  const existing = store.get(key);
  if (existing) {
    store.delete(key);
    store.set(key, existing);
  } else {
    if (store.size >= MAX_VERSIONS) {
      const evicted = store.keys().next().value as string;
      store.delete(evicted);
      dropTilesFor(evicted); // its rendered tiles can never be served again
    }
    store.set(key, { polys, height });
  }
  return key;
}

// Web-Mercator pixel of a lng/lat at zoom z (256-px tiles).
function project(lng: number, lat: number, worldSize: number): [number, number] {
  const x = ((lng + 180) / 360) * worldSize;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize;
  return [x, y];
}

// Mapbox terrain-RGB encoding: height = -10000 + (R*65536 + G*256 + B) * 0.1.
function encodeHeight(h: number): [number, number, number] {
  const v = Math.round((h + 10000) * 10);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const SIZE = 256;

// Rasterise the selection's polygons into an inside/outside mask of (SIZE+2·pad)²
// texels for one tile (pad = extra texels beyond the tile edge, so derived bands
// stay continuous across tile seams). The SINGLE rasteriser for both the DEM and
// the shade tiles — they must agree texel-for-texel or the shading drifts off the
// wall (a vector-drawn band zigzags against the texel staircase and looks striped).
function rasterizeMask(sel: Selection, z: number, x: number, y: number, pad: number): Uint8Array {
  const worldSize = SIZE * Math.pow(2, z);
  const originX = x * SIZE;
  const originY = y * SIZE;
  const W = SIZE + 2 * pad;
  const inside = new Uint8Array(W * W);
  for (const poly of sel.polys) {
    // Only the edges spanning some of this tile's rows can cross its scanlines:
    // a raised département has thousands of edges and a tile meets a handful,
    // so they are sorted out once per tile rather than run through for each row.
    const ex1: number[] = [];
    const ey1: number[] = [];
    const ex2: number[] = [];
    const ey2: number[] = [];
    for (const ring of poly) {
      const px = ring.map(([lng, lat]) => {
        const [x, y] = project(lng, lat, worldSize);
        return [x - originX + pad, y - originY + pad] as [number, number];
      });
      for (let i = 0, j = px.length - 1; i < px.length; j = i++) {
        const y1 = px[j][1];
        const y2 = px[i][1];
        if ((y1 < 0 && y2 < 0) || (y1 > W && y2 > W)) continue;
        ex1.push(px[j][0]);
        ey1.push(y1);
        ex2.push(px[i][0]);
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

// The DEM plateau is ERODED inward by this many texels relative to the vector
// polygon: the raster wall (texel staircase, quantised to the terrain mesh grid)
// then always sits strictly INSIDE the vector footprint, so the black band panels
// (thin fill-extrusions standing ON the vector boundary, client-side) rest on
// ground-level terrain at every zoom and are never occluded by the terrain wall.
const ERODE_TEXELS = 2.5;

// Rendered tiles, keyed version/z/x/y. renderTile is a PURE function of that key
// (a version's Selection is immutable once stored), so the same tile was being
// re-rasterised — mask + two-pass chamfer over a 266² grid + PNG deflate — on
// every single GET. Drilling fires a burst of 20-80 tile requests, all of them
// synchronous CPU on the event loop, right when the user has just clicked and is
// also waiting on /api/boundaries. Memoising removes the repeat cost entirely.
const TILE_CACHE_MAX = 4000; // ~6 MB of PNG buffers
const tileCache = new Map<string, Buffer>();

function cacheTile(key: string, png: Buffer): Buffer {
  if (tileCache.size >= TILE_CACHE_MAX) {
    // Map preserves insertion order — drop the oldest entry.
    tileCache.delete(tileCache.keys().next().value as string);
  }
  tileCache.set(key, png);
  return png;
}

/** Drop a version's rendered tiles when the version itself is evicted. */
function dropTilesFor(version: string): void {
  const prefix = `${version}/`;
  for (const k of tileCache.keys()) if (k.startsWith(prefix)) tileCache.delete(k);
}

/** Render the plateau DEM for one tile, or null if the version is unknown.
 *  Hard step: eroded-inside = full height, elsewhere 0, transition in a single
 *  pixel — so the sides render as a perfectly VERTICAL wall (no slope) at any zoom. */
export function renderTile(version: string, z: number, x: number, y: number): Buffer | null {
  const sel = store.get(version);
  if (!sel) return null;
  // A held version is exercised via tile GETs — touch recency on those too.
  store.delete(version);
  store.set(version, sel);

  const cacheKey = `${version}/${z}/${x}/${y}`;
  const hit = tileCache.get(cacheKey);
  if (hit) {
    // Touch recency so a version being actively panned stays resident.
    tileCache.delete(cacheKey);
    tileCache.set(cacheKey, hit);
    return hit;
  }

  const PAD = Math.ceil(ERODE_TEXELS) + 2;
  const W = SIZE + 2 * PAD;
  const inside = rasterizeMask(sel, z, x, y, PAD);

  // Distance (texels) from each inside texel to the outside — 2-pass chamfer.
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
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const c = dist[(py + PAD) * W + (px + PAD)] > ERODE_TEXELS ? plateau : ground;
      const o = (py * SIZE + px) * 3;
      rgb[o] = c[0];
      rgb[o + 1] = c[1];
      rgb[o + 2] = c[2];
    }
  }
  return cacheTile(cacheKey, encodePNG(rgb, SIZE, SIZE));
}
