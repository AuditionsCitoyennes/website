// The pending mark's meshes: ONE unit's boundary as line quads (the stroke)
// and its surface as flat triangles (the fill), built from the outline in
// memory at the tap, each regime's set on its own — and the mark's small
// numbers: its looks, its fade, where it stands. Pure: no mapbox-gl, no page
// (the per-geometry ring cache of lib/projection.ts is all it reads), so it
// runs under node (pendingMark.test.ts). gl/PendingMarkPass.ts draws them.
//
// The stroke's vertices have the boundary lines' own layout (gl/meshBuild.ts:
// a vertex, its segment's other end, the offset side, the geometric side), so
// the mark's programs take the same attributes; the fill's have the hover
// fill's ([position, distance], the distance always 0: a flat fill has no
// sweep), so the hover fill's programs draw it as they are.

import earcut, { flatten } from "earcut";
import { ringBasesOf, type PBase } from "../lib/projection";

/** A unit's outline, as the layer's other meshes take it. */
export type MarkGeometry = { type?: string; coordinates?: unknown };

/** Where a mark on the ground stands, metres: the stroke with the ground
 *  lines (gl/meshBuild.ts), the fill under them. */
export const MARK_GROUND_LINE_M = 12;
export const MARK_GROUND_FILL_M = 8;
/** On a lid `h` metres up: the fill just over it, the stroke over the lid's
 *  own lines' height (h × 1.001 and h × 1.002 there too). */
export const markLidFillM = (h: number) => h * 1.001;
export const markLidLineM = (h: number) => h * 1.002;

/** Past this many boundary vertices the fill is left out (the stroke alone
 *  stands): its triangulation runs on the page, in the frame that answers the
 *  tap. A unit's outline in memory at a tap is nearly always under it (a
 *  région's coarse entry a few hundred vertices, a département's about two
 *  thousand); a large country's fine outline (up to 13,445) is not. */
export const MARK_FILL_MAX_VERTICES = 4000;

/** The stroke, CSS px: a violet band with a light core — lighter and thicker
 *  than a boundary line (0.9 to 1.7 px of plain violet), and not a hover (a
 *  fill). Straight sRGB 0..1; alphas before the fade. */
export const MARK_BAND = { width: 6, rgb: [0.486, 0.361, 1.0], alpha: 0.9 } as const;
export const MARK_CORE = { width: 2.5, rgb: [0.94, 0.91, 1.0], alpha: 1 } as const;
/** The fill's share of the hover fill's opacity (0.6 there): lighter than a
 *  hover, over a whole territory on a phone. */
export const MARK_FILL_SHARE = 0.7;

/** How long the mark takes to go once its plateau commits, ms (the selection
 *  retract's own time). */
export const MARK_FADE_MS = 117;

/** The mark's opacity `now`: 1 while it is held (`fadeT0` 0), then down to 0
 *  over MARK_FADE_MS from `fadeT0`. */
export function markOpacity(now: number, fadeT0: number): number {
  if (!fadeT0) return 1;
  const t = (now - fadeT0) / MARK_FADE_MS;
  return t >= 1 ? 0 : t <= 0 ? 1 : 1 - t;
}

/** The hover fill program's threshold (uFillT) that draws a vertex of
 *  distance 0 at `share` of the hover fill's opacity: its fragment shader
 *  keeps 1 − smoothstep(T − 0.12, T, 0), which this inverts. 1 → 0.12 (the
 *  whole opacity), 0 → 0 (nothing). */
export function fillThreshold(share: number): number {
  const s = 1 - Math.min(1, Math.max(0, share));
  // smoothstep's inverse on [0, 1]: the root of 3t² − 2t³ = s in [0, 1].
  const t = 0.5 - Math.sin(Math.asin(1 - 2 * s) / 3);
  return 0.12 * (1 - t);
}

/** One regime's set of a mark. */
export interface MarkSet {
  /** Mercator: what the vertices are relative to. Globe: [0, 0] (absolute). */
  origin: [number, number];
  line: Float32Array<ArrayBuffer>;
  lineCount: number;
  fill: Float32Array<ArrayBuffer>;
  fillCount: number;
}

/** A geometry's boundary vertices, all rings. */
export function markVertexCount(g: MarkGeometry): number {
  let n = 0;
  for (const rings of ringBasesOf(g)) for (const ring of rings) n += ring.length;
  return n;
}

/** The first vertex of the first ring with a segment; null: nothing to draw. */
function originOf(polys: PBase[][][]): [number, number] | null {
  for (const rings of polys) {
    for (const ring of rings) if (ring.length >= 2) return [ring[0].x, ring[0].y];
  }
  return null;
}

/** A polygon's triangles, as vertices: plain earcut over its rings (holes
 *  kept). No curvature refine: the fill is one flat colour, so only its edge
 *  shows, and its edge is the boundary's own vertices. */
function trianglesOf(rings: PBase[][]): PBase[] {
  const data = flatten(rings.map((ring) => ring.map((p) => [p.x, p.y])));
  const idx = earcut(data.vertices, data.holes, data.dimensions);
  const flat = rings.flat();
  return idx.map((i) => flat[i]);
}

/**
 * A mark's set for one regime: the stroke at `lineM` metres and, when `want.
 * fill`, the fill at `fillM`. Mercator: [x, y, z, ox, oy, oz, side, geomSide]
 * and [x, y, z, 0], relative to the first vertex. Globe: [merc3, lo3, hi3,
 * oMerc3, oLo3, oHi3, side, geomSide] and [merc3, lo3, hi3, 0], absolute.
 * Null: a geometry with no segment.
 */
export function buildMarkSet(
  g: MarkGeometry,
  regime: "merc" | "globe",
  lineM: number,
  fillM: number,
  want: { stroke: boolean; fill: boolean },
): MarkSet | null {
  const polys = ringBasesOf(g);
  const first = originOf(polys);
  if (!first) return null;
  const merc = regime === "merc";
  const [ox, oy] = merc ? first : [0, 0];
  let line = new Float32Array(0);
  let lineCount = 0;
  if (want.stroke) {
    let segments = 0;
    for (const rings of polys) for (const ring of rings) segments += Math.max(0, ring.length - 1);
    lineCount = segments * 6;
    const stride = merc ? 8 : 20;
    line = new Float32Array(lineCount * stride);
    let o = 0;
    // A vertex stored at B sees the segment's direction flipped, so its
    // offset side inverts; the geometric side stays (see gl/meshBuild.ts).
    const put = (p: PBase, q: PBase, side: number, geomSide: number) => {
      if (merc) {
        line[o++] = p.x - ox;
        line[o++] = p.y - oy;
        line[o++] = lineM * p.zPerM;
        line[o++] = q.x - ox;
        line[o++] = q.y - oy;
        line[o++] = lineM * q.zPerM;
      } else {
        for (const v of [p, q]) {
          line[o++] = v.x;
          line[o++] = v.y;
          line[o++] = lineM * v.zPerM;
          line[o++] = v.lo[0];
          line[o++] = v.lo[1];
          line[o++] = v.lo[2];
          line[o++] = v.lo[0] + lineM * v.d[0];
          line[o++] = v.lo[1] + lineM * v.d[1];
          line[o++] = v.lo[2] + lineM * v.d[2];
        }
      }
      line[o++] = side;
      line[o++] = geomSide;
    };
    for (const rings of polys) {
      for (const ring of rings) {
        for (let i = 0; i + 1 < ring.length; i++) {
          const a = ring[i];
          const b = ring[i + 1];
          put(a, b, +1, +1); // A+
          put(b, a, -1, +1); // B+
          put(b, a, +1, -1); // B-
          put(a, b, +1, +1); // A+
          put(b, a, +1, -1); // B-
          put(a, b, -1, -1); // A-
        }
      }
    }
  }
  let fill = new Float32Array(0);
  let fillCount = 0;
  if (want.fill && markVertexCount(g) <= MARK_FILL_MAX_VERTICES) {
    const tris: PBase[] = [];
    for (const rings of polys) for (const p of trianglesOf(rings)) tris.push(p);
    fillCount = tris.length;
    const stride = merc ? 4 : 10;
    fill = new Float32Array(fillCount * stride);
    let o = 0;
    for (const p of tris) {
      fill[o++] = p.x - ox;
      fill[o++] = p.y - oy;
      fill[o++] = fillM * p.zPerM;
      if (!merc) {
        fill[o++] = p.lo[0];
        fill[o++] = p.lo[1];
        fill[o++] = p.lo[2];
        fill[o++] = p.lo[0] + fillM * p.d[0];
        fill[o++] = p.lo[1] + fillM * p.d[1];
        fill[o++] = p.lo[2] + fillM * p.d[2];
      }
      fill[o++] = 0; // the distance to the boundary: none, a flat fill
    }
  }
  return { origin: [ox, oy], line, lineCount, fill, fillCount };
}
