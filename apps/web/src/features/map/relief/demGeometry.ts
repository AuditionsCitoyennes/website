// The light half of the plateau relief: the constants, the polygons the server
// keeps of a selection, its version key and the tile touch test. No raster, no
// PNG: what the main thread needs to name a selection and sort its tiles
// without loading the renderer (demRaster.ts, which re-exports all of this).
// Pure: no DOM, no Vue; the key uses crypto.subtle where the engine has it.

import { fnv1a64 } from "./demTiles";

export const SIZE = 256;
export const ERODE_TEXELS = 2.5;
export const PAD = Math.ceil(ERODE_TEXELS) + 2;
/** The renderer's revision (the API's RENDER_REV, kept), folded into the version key. */
export const RENDER_REV = 1;
/** The API's MAX_SELECTION_VERTICES, kept: above it, no selection is raised. */
export const MAX_SELECTION_VERTICES = 250_000;

export type Ring = [number, number][];
export type Polygon = Ring[]; // [exterior, ...holes]

/** The selection holds more vertices than the relief will raise (the API's 413, kept). */
export class SelectionTooLarge extends Error {
  constructor(vertices: number) {
    super(`selection too large: ${vertices} vertices (max ${MAX_SELECTION_VERTICES})`);
    this.name = "SelectionTooLarge";
  }
}

/** The polygons the server keeps of the POSTed features (setSelection). */
export function polysOf(
  features: readonly { geometry?: unknown; type?: string; coordinates?: unknown }[],
): Polygon[] {
  const polys: Polygon[] = [];
  for (const f of features) {
    const g = (f.geometry ?? f) as { type?: string; coordinates?: unknown };
    if (!g?.type) continue;
    const list = (
      g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
    ) as Polygon[];
    for (const poly of list) polys.push(poly);
  }
  return polys;
}

/** Every ring's length, summed: what the server compares to MAX_SELECTION_VERTICES. */
export function vertexCount(polys: Polygon[]): number {
  let n = 0;
  for (const poly of polys) for (const ring of poly) n += ring.length;
  return n;
}

/** The string the server hashes for the version key, after its RENDER_REV line. */
export function keyJson(polys: Polygon[], height: number): string {
  return JSON.stringify({ polys, height: Math.round(height) });
}

type Digest = (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;

/**
 * The version key of a `keyJson` string: the first 32 hex digits of the SHA-1
 * of `RENDER_REV + "\n" + json`, the server's. Without a digest (`null`, or an
 * insecure context that has no crypto.subtle) it is `"f" + fnv1a64(...)`: a
 * page-local key, never sent anywhere, that no server key can equal.
 */
export async function keyOfJson(json: string, digest?: Digest | null): Promise<string> {
  const text = `${RENDER_REV}\n${json}`;
  const sha1 =
    digest !== undefined
      ? digest
      : typeof crypto !== "undefined" && crypto.subtle
        ? (b: Uint8Array<ArrayBuffer>) => crypto.subtle.digest("SHA-1", b)
        : null;
  if (!sha1) return "f" + fnv1a64(text);
  const hash = new Uint8Array(await sha1(new TextEncoder().encode(text)));
  let hex = "";
  for (const b of hash) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 32);
}

/**
 * The server's version key for a selection: `keyOfJson` of its `keyJson`.
 * Same polygons and same rounded height, same key, whoever renders.
 */
export function demKey(
  polys: Polygon[],
  height: number,
  digest: Digest = (b) => crypto.subtle.digest("SHA-1", b),
): Promise<string> {
  return keyOfJson(keyJson(polys, height), digest);
}

/** Whether tile z/x/y, with its PAD and one texel more, can hold a plateau texel at all. */
export function tileTouches(
  bbox: readonly [number, number, number, number],
  z: number,
  x: number,
  y: number,
): boolean {
  const ws = SIZE * Math.pow(2, z);
  const ox = x * SIZE - PAD - 1;
  const oy = y * SIZE - PAD - 1;
  const ex = (x + 1) * SIZE + PAD + 1;
  const ey = (y + 1) * SIZE + PAD + 1;
  return bbox[2] * ws >= ox && bbox[0] * ws <= ex && bbox[3] * ws >= oy && bbox[1] * ws <= ey;
}
