// The flat view's grey sheet, cut (gl/ScopeTintLayer.ts draws it): one mesh
// of the whole mercator world with the selection's outer rings as holes, plus
// the selection's enclaves filled back in. A pure function of the selection's
// geometries and the per-geometry projection cache (lib/projection.ts): no
// mapbox-gl, no page (lib/corePurity.test.ts), so the mesh worker cuts it
// with the same code as the page (ac:tint-cut, ../threadSwitch.ts).

import earcut from "earcut";
import { ringBasesOf, type PBase } from "../lib/projection";

/** A (multi)polygon whose rings the grey is cut around. */
export type MaskGeom = { type?: string; coordinates?: unknown };

/** The sheet: triangles as x, y pairs relative to `origin` (mercator). */
export interface TintSheet {
  positions: Float32Array<ArrayBuffer>;
  origin: [number, number];
}

/** The sheet cut around `geoms` (none, or none with a ring: no triangle, no
 *  grey). */
export function cutTintSheet(geoms: readonly MaskGeom[]): TintSheet {
  // Outer rings become holes; a selection's INNER rings are enclaves of some
  // other unit (the Enclave des Papes is Vaucluse, wholly surrounded by
  // Drôme), which the plateau leaves un-raised — so they are greyed back in,
  // as polygons of their own sitting exactly inside a hole. Assumes what
  // admin boundaries give: outer rings that neither overlap nor nest (no part
  // of the selection inside its own enclave) — `worldMaskData` shares that.
  const holes: PBase[][] = [];
  const enclaves: PBase[][] = [];
  for (const g of geoms) {
    for (const rings of ringBasesOf(g)) {
      if (!rings[0]?.length) continue;
      holes.push(rings[0]);
      for (let i = 1; i < rings.length; i++) if (rings[i]?.length) enclaves.push(rings[i]);
    }
  }
  if (!holes.length) return { positions: new Float32Array(0), origin: [0, 0] };
  const out: number[] = [];
  // Coordinates are relative to a vertex of the selection: float32 keeps
  // sub-metre precision on those small offsets, and the origin is re-added
  // in the (float64) matrix each frame — the same fold PlateauWallLayer uses.
  const ox = holes[0][0].x;
  const oy = Math.min(1, Math.max(0, holes[0][0].y));
  // The world, one copy to each side so the grey does not stop at ±180°.
  const W = [-1 - ox, -oy, 2 - ox, 1 - oy];
  // Mercator y runs off to infinity toward the poles. Pin it to the world's
  // edge so every hole stays inside the frame below — earcut silently drops
  // a hole that pokes out of its outer ring, which would grey the selection.
  const relY = (p: PBase) => Math.min(W[3], Math.max(W[1], p.y - oy));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of holes) {
    for (const p of ring) {
      x0 = Math.min(x0, p.x - ox);
      x1 = Math.max(x1, p.x - ox);
      y0 = Math.min(y0, relY(p));
      y1 = Math.max(y1, relY(p));
    }
  }
  // Earcut works inside a FRAME one selection-span wide around the holes,
  // not against the world's corners: its triangles stay short and local
  // (where the float32 fold is precise). The rest of the world is the ring
  // of eight triangles between frame and world — they share the frame's
  // corners with earcut's output, so no T-junction can open a crack.
  const pad = Math.max(x1 - x0, y1 - y0, 1e-7);
  const F = [
    Math.max(W[0], x0 - pad),
    Math.max(W[1], y0 - pad),
    Math.min(W[2], x1 + pad),
    Math.min(W[3], y1 + pad),
  ];
  const sheet: number[] = [F[0], F[1], F[2], F[1], F[2], F[3], F[0], F[3]];
  const holeStarts: number[] = [];
  for (const ring of holes) {
    holeStarts.push(sheet.length / 2);
    for (const p of ring) sheet.push(p.x - ox, relY(p));
  }
  for (const i of earcut(sheet, holeStarts, 2)) out.push(sheet[i * 2], sheet[i * 2 + 1]);
  const corners = (r: number[]) => [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]];
  const f = corners(F);
  const w = corners(W);
  for (let i = 0; i < 4; i++) {
    const j = ((i + 1) % 4) * 2;
    const k = i * 2;
    out.push(w[k], w[k + 1], w[j], w[j + 1], f[j], f[j + 1]);
    out.push(w[k], w[k + 1], f[j], f[j + 1], f[k], f[k + 1]);
  }
  for (const ring of enclaves) {
    const flat: number[] = [];
    for (const p of ring) flat.push(p.x - ox, relY(p));
    for (const i of earcut(flat, undefined, 2)) out.push(flat[i * 2], flat[i * 2 + 1]);
  }
  return { positions: new Float32Array(out), origin: [ox, oy] };
}
