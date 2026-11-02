// The mesh pieces the plateau and the analyses' slabs are assembled from
// (PlateauWallLayer): a vertex in each regime's layout, a ring's wall, a
// piece's coloured top, the halo's ribbon — and the two numbers both share,
// the wall's overshoot over the plateau (WALL_OVERSHOOT: its only home) and
// the violet.

import { baseOf, type PBase } from "../lib/projection";

export const WALL_OVERSHOOT = 1.02; // top slightly above the plateau: no smeared sliver

/** The plateau's violet (the walls' shader's), straight sRGB 0..1. */
export const VIOLET = [0.486, 0.361, 1.0] as const;

// ---- Mesh pieces shared by the plateau and the analyses' slabs -------------------

/** A globe vertex: absolute mercator (z at FULL altitude; 0 for a wall's foot)
 *  and the ECEF ground/full pair — 9 floats. A null `arr`: no globe set is
 *  built (the plateau's mercator-first build, ac:mesh=merc). */
export function pushGlobeVert(arr: number[] | null, b: PBase, alt: number, bottom = false) {
  if (!arr) return;
  arr.push(b.x, b.y, bottom ? 0 : alt * b.zPerM, b.lo[0], b.lo[1], b.lo[2]);
  if (bottom) arr.push(b.lo[0], b.lo[1], b.lo[2]);
  else arr.push(b.lo[0] + alt * b.d[0], b.lo[1] + alt * b.d[1], b.lo[2] + alt * b.d[2]);
}

/** One ring's wall: a quad (two triangles) per edge, ground → `h`, mercator
 *  relative to `origin` (3 floats a vertex) and the globe's (9) — each with
 *  `rgb` after it, when given (the slabs' pieces: 6 and 12). A null sink is
 *  a set not built (the plateau's, ac:mesh=merc; the slabs pass both). */
export function pushWallRing(
  ring: PBase[],
  origin: [number, number],
  h: number,
  verts: number[] | null,
  gWall: number[] | null,
  rgb?: readonly number[],
) {
  const put = (b: PBase, top: boolean) => {
    verts?.push(b.x - origin[0], b.y - origin[1], top ? h * b.zPerM : 0);
    pushGlobeVert(gWall, b, h, !top);
    if (rgb) {
      verts?.push(rgb[0], rgb[1], rgb[2]);
      gWall?.push(rgb[0], rgb[1], rgb[2]);
    }
  };
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    put(a, false);
    put(b, false);
    put(b, true);
    put(a, false);
    put(b, true);
    put(a, true);
  }
}

/** A slab piece's top vertex at `h`, coloured: mercator [x, y, z, r, g, b]
 *  relative to `origin`, the globe's [merc3, lo3, hi3, rgb3]. */
export function pushPieceVert(
  b: PBase,
  origin: [number, number],
  h: number,
  rgb: readonly number[],
  verts: number[],
  gVerts: number[],
) {
  verts.push(b.x - origin[0], b.y - origin[1], h * b.zPerM, rgb[0], rgb[1], rgb[2]);
  pushGlobeVert(gVerts, b, h);
  gVerts.push(rgb[0], rgb[1], rgb[2]);
}

/** A halo vertex at `alt` m: mercator [x, y, z, d] relative to `origin`, and
 *  the globe's [merc3, lo3, hi3, d]. A null sink: that set is not built. */
export function pushHaloVert(
  verts: number[] | null,
  gVerts: number[] | null,
  b: PBase,
  d: number,
  origin: [number, number],
  alt: number,
) {
  const z = alt * b.zPerM;
  verts?.push(b.x - origin[0], b.y - origin[1], z, d);
  if (!gVerts) return;
  gVerts.push(b.x, b.y, z, b.lo[0], b.lo[1], b.lo[2]);
  gVerts.push(b.lo[0] + alt * b.d[0], b.lo[1] + alt * b.d[1], b.lo[2] + alt * b.d[2], d);
}

/**
 * The halo's ribbon along one ring: its inner edge (d = 0) on the ring itself,
 * full resolution — exactly where the wall stands —, its outer edge (d = 1)
 * `W` out (° of latitude-equivalent; longitudes scaled by `cosH`). Only the
 * offset DIRECTION is smoothed (the normal comes from the chord across a
 * ±0.5·W arc window), so the outer edge stays calm on jagged boundaries.
 * Triangles, a vertex at a time, to `push`.
 */
export function buildHaloRing(
  ringB: PBase[],
  W: number,
  cosH: number,
  push: (b: PBase, d: number) => void,
) {
  const pts: PBase[] = ringB.slice();
  const p0r = pts[0];
  const pnr = pts[pts.length - 1];
  if (!p0r || !pnr) return;
  if (Math.abs(p0r.lng - pnr.lng) < 1e-9 && Math.abs(p0r.lat - pnr.lat) < 1e-9) pts.pop();
  const n = pts.length;
  if (n < 4) return;
  // Cumulative arc length (scaled-lng metric) for the smoothing window.
  const arc = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = (b.lng - a.lng) * cosH;
    const dy = b.lat - a.lat;
    arc[i + 1] = arc[i] + Math.hypot(dx, dy);
  }
  const total = arc[n];
  if (total < W) return; // degenerate speck
  const win = Math.min(W * 0.5, total / 6);
  const at = (s: number): [number, number] => {
    // Point at arc position s (wrapped) via linear scan window — n is
    // walked with two monotone pointers overall, this stays cheap.
    const sw = ((s % total) + total) % total;
    let lo = 0;
    let hi = n;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] <= sw) lo = mid;
      else hi = mid;
    }
    const segLen = arc[lo + 1] - arc[lo] || 1e-12;
    const t = (sw - arc[lo]) / segLen;
    const a = pts[lo];
    const b = pts[(lo + 1) % n];
    return [a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t];
  };
  const normals: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const back = at(arc[i] - win);
    const fwd = at(arc[i] + win);
    const dx = (fwd[0] - back[0]) * cosH;
    const dy = fwd[1] - back[1];
    const len = Math.hypot(dx, dy) || 1e-12;
    normals[i] = [-dy / len, dx / len];
  }
  // Orientation: offset a test point and even-odd test the ring — flip so the
  // band goes OUTWARD.
  const testLng = pts[0].lng + (normals[0][0] * W * 0.5) / cosH;
  const testLat = pts[0].lat + normals[0][1] * W * 0.5;
  let inside = false;
  for (let i = 0, j = ringB.length - 1; i < ringB.length; j = i++) {
    const yi = ringB[i].lat;
    const yj = ringB[j].lat;
    if (
      yi > testLat !== yj > testLat &&
      testLng < ((ringB[j].lng - ringB[i].lng) * (testLat - yi)) / (yj - yi) + ringB[i].lng
    ) {
      inside = !inside;
    }
  }
  const flip = inside ? -1 : 1;
  // Inner ring = the cached bases themselves; only the OFFSET outer ring needs
  // fresh projections.
  const inner = pts;
  const outer = pts.map((b, i) =>
    baseOf(b.lng + (flip * normals[i][0] * W) / cosH, b.lat + flip * normals[i][1] * W),
  );
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(inner[i], 0);
    push(inner[j], 0);
    push(outer[j], 1);
    push(inner[i], 0);
    push(outer[j], 1);
    push(outer[i], 1);
  }
}
