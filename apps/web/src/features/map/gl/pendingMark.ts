// The pending mark's meshes and numbers. A tapped unit wears, until its
// plateau rises: a flat violet FILL over its surface, and a loading LINE
// along its boundary that covers the share of the boundary's length the data
// of its plateau has reached (gl/PendingMarkPass.ts draws both). Pure: no
// mapbox-gl, no page — it runs under node (pendingMark.test.ts) and in the
// mesh worker (gl/meshCore.ts builds a large unit's mark off the page).
//
// Assembled straight into typed arrays from the outline's own coordinates:
// each vertex projected once (lib/mercator.ts projectInto), no object per
// vertex.
//
// The line: one record per boundary segment — its two ends, for each the
// share of the unit's WHOLE boundary reached there, and how wide a line its
// ring can carry (below). The rings are run one after the other, the
// longest first: one line grows around the mainland, then around each
// island in turn, the islets last — never a dash on every ring at once. The
// six corners of a segment's quad are the same for every segment
// (gl/lineSegments.ts LINE_CORNERS), the segments drawn as instances of it.
//
// A ring's line is never wider than a share of the ring's own depth on
// screen (its area over its perimeter: a disc's is a quarter of its
// diameter, a ragged island's far less), so an islet, an enclave or a
// shredded coast is drawn with a hairline instead of being smeared into a
// blob. The record carries the ring's depth as a share of the whole
// boundary's length; the shader turns it into pixels with the segment's own
// pixels per length, so it follows the zoom with nothing rebuilt.
//
// The fill: flat triangles, in the hover fill's layout ([position,
// distance], the distance always 0: no sweep), so the hover fill's programs
// draw it as they are. On the globe a triangle is a flat facet under the
// sphere: along a chord of many degrees it sinks far enough for a sliver
// beside it to fold over its neighbour on screen, blended twice. So the
// globe's triangles are bisected until no edge is longer than
// MARK_FILL_MAX_EDGE_DEG; the flat view's are left as earcut gives them.
//
// Heights: every vertex stands at MARK_REF_M metres, and the draw scales it
// (uScale = metres / MARK_REF_M: both projections are linear in altitude),
// so a mark goes from the ground to a lid, and rides a rise, with no rebuild.

import earcut from "earcut";
import { PROJECTED_FLOATS, projectInto } from "../lib/mercator";
import { polysOf } from "../lib/polygon";

/** A unit's outline, as the layer's other meshes take it. */
export type MarkGeometry = { type?: string; coordinates?: unknown };

/** The height the meshes are built at, metres (see the header). */
export const MARK_REF_M = 100_000;
/** Where a mark on the ground stands, metres: the line with the ground
 *  lines (gl/meshBuild.ts), the fill under them. */
export const MARK_GROUND_LINE_M = 12;
export const MARK_GROUND_FILL_M = 8;
/** On a lid `h` metres up: the fill just over it, the line over the lid's
 *  own lines' height (h × 1.001 and h × 1.002 there too). */
export const markLidFillM = (h: number) => h * 1.001;
export const markLidLineM = (h: number) => h * 1.002;

/** The loading line's width, CSS px, before the pixel of soft edge the
 *  shader adds around it (a boundary line is 0.9 to 1.7)… */
export const MARK_LINE_WIDTH = 2;
/** …on a unit whose box is at least this wide on screen, CSS px; a smaller
 *  one's is thinner in proportion, down to this share of it. */
export const MARK_LINE_FULL_PX = 240;
export const MARK_LINE_MIN_SHARE = 0.6;
/** …and, around each ring, at most this share of the ring's depth on screen
 *  (area / perimeter): the full width from a disc sixteen pixels across. */
export const MARK_LINE_RING_SHARE = 0.5;

/** The line's width, CSS px, around a unit whose box is `spanDeg` degrees
 *  wide, at the camera's `zoom` (512 px a world at zoom 0). */
export function markLineWidth(spanDeg: number, zoom: number): number {
  const px = (spanDeg / 360) * 512 * Math.pow(2, zoom);
  const share = Number.isFinite(px) ? px / MARK_LINE_FULL_PX : 1;
  return MARK_LINE_WIDTH * Math.min(1, Math.max(MARK_LINE_MIN_SHARE, share));
}
/** The fill's share of the hover fill's opacity (0.6 there): the same violet
 *  a hovered zone has, on every device. */
export const MARK_FILL_SHARE = 1;

/** The line's shortest run from one real step to the next, ms (and, under
 *  `ac:tap-fast=show`, the length of its ease). */
export const MARK_STEP_MS = 100;
/** `ac:tap-fast=hide`: the line is not drawn until this long after the
 *  first frame that drew the mark, ms — and never when the data is all in
 *  before that: a wait too short to be read shows no line at all. */
export const MARK_LINE_SHOW_MS = 200;
/** …and once drawn it runs at a constant speed, the whole boundary in this
 *  long at the fastest, ms: no frame adds more than its own time's share of
 *  the boundary (7 % at 60 Hz, 20 % in a 50 ms frame). */
export const MARK_LINE_FULL_MS = 250;
/** …and no drawn frame adds more than this share of the boundary: what a
 *  50 ms frame adds at that speed. After a longer frame (a weak device's)
 *  the run goes on from there and ends later by what was cut — five frames
 *  at least for a whole boundary, so 385 ms instead of 250 at 13 frames a
 *  second. */
export const MARK_LINE_FRAME_MAX = 0.2;
/** Under short motion (a weak device's) a run of the line asks for a frame
 *  this often, ms, while the map draws none of its own. */
export const MARK_SHORT_FRAME_MS = 50;
/** The fill's fade once the data is all in, ms: linear, down to
 *  MARK_UNFILL_FLOOR of itself ahead of the rise; the rest goes with the
 *  rise's first frame (or fades on if no rise takes it). */
export const MARK_UNFILL_MS = 80;
/** The share of the fill kept until the plateau says its rise is cleared:
 *  the unit is never bare and flat while something still holds the rise. */
export const MARK_UNFILL_FLOOR = 0.2;
/** A whole line no frame has shown counts as seen this long after its run
 *  ended, ms (a hidden tab draws no frame: the rise must still come). */
export const MARK_WHOLE_UNSEEN_MS = 100;
/** Reduced motion, where nothing fades: the end is two plain steps — the
 *  line whole over the fill, held this long, ms (three frames: seen, not
 *  animated), then the fill gone, MARK_REDUCED_GAP_MS (two frames) before
 *  the plateau rises. */
export const MARK_REDUCED_HOLD_MS = 50;
export const MARK_REDUCED_GAP_MS = 34;
/** The fade of a line that rides the rising lid (`ac:tap-end=together`, or
 *  a mark with no fill), of a mark whose wait turned late, and of a line
 *  whose file was given up, ms. */
export const MARK_FADE_MS = 117;
/** A mark whose plateau never rose is cleared this long after its data
 *  was all in, ms (a safety: nothing known leaves one). Past the longest a
 *  committed plateau waits to rise: the old one's sink (150 ms), the commit,
 *  the camera's landing (plateau/riseSwitch.ts LAND_WAIT_CAP_MS, 3.5 s). */
export const MARK_LINE_HOLD_CAP_MS = 6000;

/** A unit with at most this many boundary vertices is built on the page, in
 *  the frame that answers the tap (a région's coarse entry a few hundred, a
 *  département's about two thousand); a larger one off that frame. */
export const MARK_PAGE_MAX_VERTICES = 4000;
/** …and, on the globe, the bisection of one whose box spans more than this
 *  many degrees is left out of that frame: its cost grows with the surface.
 *  Measured on every outline file of at most MARK_PAGE_MAX_VERTICES (node,
 *  this build): the plain fill 0.1 to 0.6 ms, the bisected one of a country
 *  as wide as China, Australia or Brazil 1.5 to 2.2 ms, of Antarctica 6.7 —
 *  about 35 ms more in the tap's frame on a weak phone (CPU six times
 *  slower). So a wide unit is filled plain in the tap's frame, and its
 *  bisected fill takes the plain one's place when it lands. */
export const MARK_PAGE_MAX_SPAN_DEG = 20;
/** The globe fill's longest edge, degrees of arc. */
export const MARK_FILL_MAX_EDGE_DEG = 2;

/** A large unit's first fill (built on the page, in the frame that answers
 *  the tap, while its real meshes are built off that frame): its outline
 *  thinned to about this many boundary vertices. */
export const MARK_STANDIN_VERTICES = 1500;

/** `ac:tap-steps=creep`: over the first seconds after the tap the line also
 *  slides ahead of what has arrived — by MARK_CREEP_LEAD of the boundary at
 *  most, with this time constant, frozen MARK_CREEP_FREEZE_MS after the tap.
 *  The lead rides on top of the real value: a real step always moves the
 *  line by its own length. A repaint is asked at most every
 *  MARK_CREEP_TICK_MS while the lead grows — less often under short motion
 *  (a weak device's), and none while the map draws frames of its own. */
export const MARK_CREEP_LEAD = 0.06;
export const MARK_CREEP_TAU_MS = 1500;
export const MARK_CREEP_FREEZE_MS = 4000;
export const MARK_CREEP_TICK_MS = 100;
export const MARK_CREEP_TICK_SHORT_MS = 250;
/** The lead never takes the line past this before the data is all in (a
 *  real value past it is shown as it is). */
export const MARK_CREEP_MAX = 0.9;

/** The line's value `t` (0..1) of the way through an ease from `from` to
 *  `to` (ease-out cubic). */
export function easeStep(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  if (t <= 0) return from;
  return from + (to - from) * (1 - Math.pow(1 - t, 3));
}

/** How far ahead of the real value the creeping line is, `ms` after the tap. */
export function creepLead(ms: number): number {
  const t = Math.min(Math.max(0, ms), MARK_CREEP_FREEZE_MS);
  return MARK_CREEP_LEAD * (1 - Math.exp(-t / MARK_CREEP_TAU_MS));
}

/** The creeping line's value `ms` after the tap, the real value being `real`. */
export function creepShown(real: number, ms: number): number {
  if (real >= MARK_CREEP_MAX) return real;
  return Math.min(MARK_CREEP_MAX, real + creepLead(ms));
}

/** A linear fade's opacity `now`: 1 until `t0`, 0 from `t0 + ms` (`t0` 0:
 *  not started, 1; `ms` 0: a plain step at `t0`). */
export function fadeAlpha(now: number, t0: number, ms: number): number {
  if (!t0) return 1;
  if (ms <= 0) return now >= t0 ? 0 : 1;
  const t = (now - t0) / ms;
  return t >= 1 ? 0 : t <= 0 ? 1 : 1 - t;
}

/** How long the line takes from `from` to `to` at its constant speed, ms:
 *  `fullMs` for the whole boundary, never less than `minMs` (a small step
 *  is still seen moving). */
export function lineEaseMs(
  from: number,
  to: number,
  fullMs = MARK_LINE_FULL_MS,
  minMs = MARK_STEP_MS,
): number {
  const ms = fullMs * Math.max(0, to - from);
  return Math.min(Math.max(ms, Math.min(minMs, fullMs)), fullMs);
}

/** The line's value `t` (0..1) of the way through a run from `from` to `to`
 *  at a constant speed. */
export function lineRun(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  if (t <= 0) return from;
  return from + (to - from) * t;
}

/**
 * The unfill's opacity `now`: a linear fade over `ms` from `t0` (0: not
 * begun, 1) that stops at `floor` — the share kept until the rise takes it
 * away. `ms` 0: a plain step at `t0`, no floor.
 */
export function unfillAlpha(now: number, t0: number, ms: number, floor = 0): number {
  if (!t0) return 1;
  if (ms <= 0) return now >= t0 ? 0 : 1;
  return Math.max(floor, Math.min(1, 1 - (now - t0) / ms));
}

/** When the unfill above is down to its floor (a plain step: its own time). */
export function unfillFloorAt(t0: number, ms: number, floor: number): number {
  return ms <= 0 ? t0 : t0 + (1 - Math.min(1, Math.max(0, floor))) * ms;
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

/** A geometry's boundary vertices, all rings — counted, nothing projected. */
export function ringVertexCount(g: MarkGeometry): number {
  let n = 0;
  for (const rings of polysOf(g)) for (const ring of rings) n += ring.length;
  return n;
}

export type MarkRegime = "merc" | "globe";

/** Where a unit's mark is built: on the page in the frame that draws it
 *  ("page"); there too but its globe fill plain, the bisected one built off
 *  the frame and swapped in ("page-plain": a wide unit on the globe); or off
 *  that frame altogether (the mesh worker, else a task of the page's own). */
export function markBuildPlace(
  vertices: number,
  spanDeg: number,
  regime: MarkRegime,
): "page" | "page-plain" | "off-frame" {
  if (vertices > MARK_PAGE_MAX_VERTICES) return "off-frame";
  return regime === "merc" || spanDeg <= MARK_PAGE_MAX_SPAN_DEG ? "page" : "page-plain";
}

/** Floats per segment of the line: mercator [A.x, A.y, A.zRef, B.x, B.y,
 *  B.zRef, lenA, lenB, depth], relative to the origin; globe [A: merc3, lo3,
 *  hiRef3; B: the same; lenA, lenB, depth], absolute. lenA, lenB: the share
 *  of the whole boundary's length reached at each end. depth: the segment's
 *  ring's area over its perimeter, as a share of that same length. */
export const MARK_LINE_FLOATS = 9;
export const G_MARK_LINE_FLOATS = 21;
/** Floats per vertex of the fill: [x, y, zRef, 0] and [merc3, lo3, hiRef3, 0]. */
export const MARK_FILL_FLOATS = 4;
export const G_MARK_FILL_FLOATS = 10;

/** One regime's line. */
export interface MarkLine {
  /** Mercator: what the records are relative to. Globe: [0, 0]. */
  origin: [number, number];
  segs: Float32Array<ArrayBuffer>;
  segCount: number;
}

/** One regime's fill. */
export interface MarkFill {
  origin: [number, number];
  fill: Float32Array<ArrayBuffer>;
  /** Vertices (three a triangle). */
  fillCount: number;
}

const P = PROJECTED_FLOATS;

/** A polygon's rings, projected: per ring its vertex count, its vertices
 *  (PROJECTED_FLOATS each) and their [lng, lat]. */
interface Ring {
  n: number;
  p: Float64Array;
  ll: Float64Array;
}

function projectRings(g: MarkGeometry): Ring[][] {
  return projectPolys(polysOf(g));
}

function projectPolys(polys: number[][][][]): Ring[][] {
  return polys.map((rings) =>
    rings.map((ring) => {
      const n = ring.length;
      const p = new Float64Array(n * P);
      const ll = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        const lng = ring[i][0];
        const lat = ring[i][1];
        ll[i * 2] = lng;
        ll[i * 2 + 1] = lat;
        projectInto(p, i * P, lng, lat);
      }
      return { n, p, ll };
    }),
  );
}

/** The first vertex of the first ring with a segment; null: nothing to draw. */
function originOf(polys: Ring[][]): [number, number] | null {
  for (const rings of polys) {
    for (const ring of rings) if (ring.n >= 2) return [ring.p[0], ring.p[1]];
  }
  return null;
}

/** A vertex of `p` (at `i`) written at `o` in the globe layout's nine floats:
 *  mercator at the reference height, ECEF on the ground, ECEF at it. */
function putGlobe(out: Float32Array, o: number, p: Float64Array, i: number) {
  const at = i * P;
  out[o] = p[at];
  out[o + 1] = p[at + 1];
  out[o + 2] = MARK_REF_M * p[at + 2];
  out[o + 3] = p[at + 3];
  out[o + 4] = p[at + 4];
  out[o + 5] = p[at + 5];
  out[o + 6] = p[at + 3] + MARK_REF_M * p[at + 6];
  out[o + 7] = p[at + 4] + MARK_REF_M * p[at + 7];
  out[o + 8] = p[at + 5] + MARK_REF_M * p[at + 8];
}

function lineOf(polys: Ring[][], regime: MarkRegime): MarkLine | null {
  const first = originOf(polys);
  if (!first) return null;
  const merc = regime === "merc";
  const [ox, oy] = merc ? first : [0, 0];
  let segCount = 0;
  for (const rings of polys) for (const ring of rings) segCount += Math.max(0, ring.n - 1);
  const stride = merc ? MARK_LINE_FLOATS : G_MARK_LINE_FLOATS;
  const segs = new Float32Array(segCount * stride);
  // Each ring's length, vertex by vertex: chords on the ground (ECEF).
  const all: {
    p: Float64Array;
    n: number;
    cum: Float64Array;
    at: number;
    from: number;
    /** The ring's area over its perimeter squared (no unit: the same on
     *  the map as on the ground, the projection being conformal). */
    depth: number;
  }[] = [];
  let at = 0;
  for (const rings of polys) {
    for (const { n, p } of rings) {
      if (n < 2) continue;
      const cum = new Float64Array(n);
      let area2 = 0;
      let around = 0;
      for (let i = 1; i < n; i++) {
        const a = (i - 1) * P;
        const b = i * P;
        cum[i] =
          cum[i - 1] + Math.hypot(p[b + 3] - p[a + 3], p[b + 4] - p[a + 4], p[b + 5] - p[a + 5]);
        // Relative to the ring's first vertex: mercator's numbers are small
        // differences of large ones.
        const ax = p[a] - p[0];
        const ay = p[a + 1] - p[1];
        const bx = p[b] - p[0];
        const by = p[b + 1] - p[1];
        area2 += ax * by - bx * ay;
        around += Math.hypot(bx - ax, by - ay);
      }
      const depth = around > 0 ? Math.abs(area2) / 2 / (around * around) : 0;
      all.push({ p, n, cum, at, from: 0, depth });
      at += (n - 1) * stride;
    }
  }
  // The rings one after the other along the whole boundary's length, the
  // longest first (ties: as the outline lists them).
  const order = all
    .map((_, i) => i)
    .sort((i, j) => all[j].cum[all[j].n - 1] - all[i].cum[all[i].n - 1] || i - j);
  let total = 0;
  for (const i of order) {
    all[i].from = total;
    total += all[i].cum[all[i].n - 1];
  }
  // A boundary of no length (every vertex the same): reached from the start.
  const share = (len: number) => (total > 0 ? Math.min(1, len / total) : 0);
  for (const { p, n, cum, at: start, from, depth } of all) {
    let o = start;
    // The ring's depth as a share of the whole boundary's length.
    const deep = total > 0 ? (cum[n - 1] / total) * depth : 0;
    for (let i = 0; i + 1 < n; i++) {
      const a = i * P;
      const b = (i + 1) * P;
      if (merc) {
        segs[o] = p[a] - ox;
        segs[o + 1] = p[a + 1] - oy;
        segs[o + 2] = MARK_REF_M * p[a + 2];
        segs[o + 3] = p[b] - ox;
        segs[o + 4] = p[b + 1] - oy;
        segs[o + 5] = MARK_REF_M * p[b + 2];
        segs[o + 6] = share(from + cum[i]);
        segs[o + 7] = share(from + cum[i + 1]);
        segs[o + 8] = deep;
      } else {
        putGlobe(segs, o, p, i);
        putGlobe(segs, o + 9, p, i + 1);
        segs[o + 18] = share(from + cum[i]);
        segs[o + 19] = share(from + cum[i + 1]);
        segs[o + 20] = deep;
      }
      o += stride;
    }
  }
  return { origin: [ox, oy], segs, segCount };
}

/** A float array that grows as it is written. */
class Grow {
  a: Float32Array<ArrayBuffer>;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(Math.max(16, cap));
  }
  room(more: number) {
    if (this.n + more <= this.a.length) return;
    const next = new Float32Array(Math.max(this.a.length * 2, this.n + more));
    next.set(this.a.subarray(0, this.n));
    this.a = next;
  }
  done(): Float32Array<ArrayBuffer> {
    return this.a.slice(0, this.n);
  }
}

/** An edge's length, degrees of arc (the longitude's share shrunk by the
 *  latitude between its ends). Symmetric in its ends, so two triangles that
 *  share an edge judge it alike, and cut it at the same point. */
function arcDeg(lngA: number, latA: number, lngB: number, latB: number): number {
  const c = Math.cos(((latA + latB) / 2) * (Math.PI / 180));
  return Math.hypot((lngB - lngA) * c, latB - latA);
}

/** A triangle written at `o` of the bisection's stack. */
function put6(
  stack: Float64Array,
  o: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  stack[o] = x0;
  stack[o + 1] = y0;
  stack[o + 2] = x1;
  stack[o + 3] = y1;
  stack[o + 4] = x2;
  stack[o + 5] = y2;
}

function fillOf(polys: Ring[][], regime: MarkRegime, bisect = true): MarkFill | null {
  const first = originOf(polys);
  if (!first) return null;
  const merc = regime === "merc";
  // The longest edge kept: none longer than the cap, or any (a plain fill).
  const maxEdge = bisect ? MARK_FILL_MAX_EDGE_DEG : Infinity;
  const [ox, oy] = merc ? first : [0, 0];
  let vertices = 0;
  for (const rings of polys) for (const ring of rings) vertices += ring.n;
  const stride = merc ? MARK_FILL_FLOATS : G_MARK_FILL_FLOATS;
  const out = new Grow(vertices * 3 * stride);
  // The bisection's work: triangles still to judge, as [lng, lat] × 3, and
  // one projected vertex.
  let stack = new Float64Array(6 * 64);
  const one = new Float64Array(P);
  for (const rings of polys) {
    // Plain earcut over the polygon's rings in mercator (holes kept): the
    // fill is one flat colour, only its edge shows, and its edge is the
    // boundary's own vertices.
    let n = 0;
    for (const ring of rings) n += ring.n;
    if (n < 3) continue;
    const flat = new Float64Array(n * 2);
    const holes: number[] = [];
    const ringOf = new Int32Array(n);
    const indexIn = new Int32Array(n);
    let at = 0;
    for (let r = 0; r < rings.length; r++) {
      if (r > 0) holes.push(at);
      const { n: rn, p } = rings[r];
      for (let i = 0; i < rn; i++) {
        flat[at * 2] = p[i * P];
        flat[at * 2 + 1] = p[i * P + 1];
        ringOf[at] = r;
        indexIn[at] = i;
        at++;
      }
    }
    const idx = earcut(flat as unknown as number[], holes, 2);
    if (merc) {
      out.room(idx.length * stride);
      for (let k = 0; k < idx.length; k++) {
        const { p } = rings[ringOf[idx[k]]];
        const v = indexIn[idx[k]] * P;
        const o = out.n;
        out.a[o] = p[v] - ox;
        out.a[o + 1] = p[v + 1] - oy;
        out.a[o + 2] = MARK_REF_M * p[v + 2];
        out.a[o + 3] = 0; // the distance to the boundary: none, a flat fill
        out.n += stride;
      }
      continue;
    }
    for (let k = 0; k + 2 < idx.length; k += 3) {
      // One triangle of earcut's, cut until no edge is too long.
      let top = 0;
      for (let c = 0; c < 3; c++) {
        const { ll } = rings[ringOf[idx[k + c]]];
        const v = indexIn[idx[k + c]] * 2;
        stack[c * 2] = ll[v];
        stack[c * 2 + 1] = ll[v + 1];
      }
      top = 6;
      while (top > 0) {
        top -= 6;
        const ax = stack[top];
        const ay = stack[top + 1];
        const bx = stack[top + 2];
        const by = stack[top + 3];
        const cx = stack[top + 4];
        const cy = stack[top + 5];
        const ab = arcDeg(ax, ay, bx, by);
        const bc = arcDeg(bx, by, cx, cy);
        const ca = arcDeg(cx, cy, ax, ay);
        const longest = Math.max(ab, bc, ca);
        if (longest > maxEdge) {
          if (top + 12 > stack.length) {
            const next = new Float64Array(stack.length * 2);
            next.set(stack);
            stack = next;
          }
          // The longest edge cut at its middle (a + b: the same sum from
          // either side), the triangle's winding kept.
          if (ab === longest) {
            const mx = (ax + bx) / 2;
            const my = (ay + by) / 2;
            put6(stack, top, ax, ay, mx, my, cx, cy);
            put6(stack, top + 6, mx, my, bx, by, cx, cy);
          } else if (bc === longest) {
            const mx = (bx + cx) / 2;
            const my = (by + cy) / 2;
            put6(stack, top, ax, ay, bx, by, mx, my);
            put6(stack, top + 6, ax, ay, mx, my, cx, cy);
          } else {
            const mx = (cx + ax) / 2;
            const my = (cy + ay) / 2;
            put6(stack, top, ax, ay, bx, by, mx, my);
            put6(stack, top + 6, mx, my, bx, by, cx, cy);
          }
          top += 12;
          continue;
        }
        out.room(3 * stride);
        for (let c = 0; c < 3; c++) {
          projectInto(one, 0, stack[top + c * 2], stack[top + c * 2 + 1]);
          putGlobe(out.a, out.n, one, 0);
          out.a[out.n + 9] = 0;
          out.n += stride;
        }
      }
    }
  }
  return { origin: [ox, oy], fill: out.done(), fillCount: out.n / stride };
}

/** The loading line of `g` for one regime; null: a geometry with no segment. */
export function buildMarkLine(g: MarkGeometry, regime: MarkRegime): MarkLine | null {
  return lineOf(projectRings(g), regime);
}

/** The flat fill of `g` for one regime; null: a geometry with no segment.
 *  `bisect` false: the globe's triangles as earcut gives them (a wide
 *  unit's first fill: a faint seam may show along a long diagonal until the
 *  bisected one takes its place). */
export function buildMarkFill(g: MarkGeometry, regime: MarkRegime, bisect = true): MarkFill | null {
  return fillOf(projectRings(g), regime, bisect);
}

/**
 * A large unit's first fill: the flat fill of its outline thinned to about
 * MARK_STANDIN_VERTICES boundary vertices (`vertices`: how many it has) —
 * every k-th vertex of each ring kept, a ring left with fewer than three
 * dropped (a hole: left filled) — as earcut gives it, never bisected. Cheap
 * enough for the frame that answers the tap, and off the true boundary by
 * less than a few of its own segments: it stands until the real fill, built
 * off that frame, takes its place. Null: nothing left to fill.
 */
export function buildMarkStandIn(
  g: MarkGeometry,
  regime: MarkRegime,
  vertices = ringVertexCount(g),
): MarkFill | null {
  const k = Math.max(1, Math.ceil(vertices / MARK_STANDIN_VERTICES));
  const thin = (ring: number[][]): number[][] | null => {
    // Closed rings: the last vertex repeats the first.
    const open = ring.length - 1;
    if (open < 3 * k) return null;
    const out: number[][] = [];
    for (let i = 0; i < open; i += k) out.push(ring[i]);
    out.push(ring[0]);
    return out;
  };
  const polys: number[][][][] = [];
  for (const rings of polysOf(g)) {
    const outer = rings.length ? thin(rings[0]) : null;
    if (!outer) continue;
    const kept = [outer];
    for (let r = 1; r < rings.length; r++) {
      const hole = thin(rings[r]);
      if (hole) kept.push(hole);
    }
    polys.push(kept);
  }
  const fill = fillOf(projectPolys(polys), regime, false);
  return fill && fill.fillCount > 0 ? fill : null;
}

/** Both, from one projection of the outline; null: a geometry with no
 *  segment. */
export function buildMark(
  g: MarkGeometry,
  regime: MarkRegime,
  bisect = true,
): { line: MarkLine; fill: MarkFill } | null {
  const polys = projectRings(g);
  const line = lineOf(polys, regime);
  const fill = fillOf(polys, regime, bisect);
  return line && fill ? { line, fill } : null;
}
