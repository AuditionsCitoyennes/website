// The boundary lines' lean layout (ac:line-mesh=lean, plateau/lineMeshSwitch.ts;
// gl/meshBuild.ts builds it, PlateauWallLayer draws it): one record per
// SEGMENT — its two ends — instead of six vertices that each repeat both
// ends, the quad's six corners being the same for every segment
// (LINE_CORNERS, one small buffer, the segments drawn as instances of it).
// And, in the groups drawn without the depth test (the lines that ride the
// lid), a segment two units share is kept once and marked as standing for
// two: its fragments are blended once at the opacity two passes give.
//
// The pixels are the full layout's: the vertex shader reads the same two ends
// and the same two signs at each corner, and the same violet laid twice at
// opacity a is the same violet laid once at a + a(1 − a), whatever is drawn
// between the two passes (without a depth test, layers of one colour blend to
// the same result in any order). A group that IS depth-tested — the lines on
// the ground, in the flat view — keeps every segment: there a second pass
// only lands where nothing nearer was drawn since the first, which one pass
// cannot tell.
//
// Pure: no DOM, no GL (lib/corePurity.test.ts, through gl/meshBuild.ts).

import type { PBase } from "../lib/mercator";
import type { LineRange } from "./meshBuild";

/** A segment's quad, corner by corner, two triangles (A+ B+ B−, A+ B− A−):
 *  which end the corner stands at (0: A, 1: B), the side its screen offset
 *  goes to, and its geometric side (the feather's). The offset side inverts
 *  at B, where the segment's direction is seen reversed. */
export const LINE_CORNERS = new Float32Array([
  0, 1, 1, 1, -1, 1, 1, 1, -1, 0, 1, 1, 1, 1, -1, 0, -1, -1,
]);

/** Vertices a segment's quad is drawn with. */
export const SEGMENT_VERTICES = 6;
/** Floats a segment holds in the lean mercator buffer: A then B, each
 *  [x, y, z] relative to the origin. */
export const LEAN_FLOATS = 6;
/** Floats a segment holds in the lean globe buffer: A then B, each
 *  [merc3, ecefLo3, ecefHi3]. */
export const G_LEAN_FLOATS = 18;

/** What becomes of a segment: drawn as it is, drawn once for the two that
 *  lie on each other, or not drawn (the second of such a pair, or a segment
 *  of no length: its quad has no area). */
export const ONCE = 0;
export const TWICE = 1;
export const OUT = 2;

/** A line group's segments, as the rings give them: segment i runs from
 *  `a[i]` to `b[i]` at `alt` metres. */
export interface SegmentGroup {
  width: number;
  alpha: number;
  raised: boolean;
  alt: number;
  a: PBase[];
  b: PBase[];
}

const f64 = new Float64Array(2);
const u32 = new Uint32Array(f64.buffer);

/** A point's hash, from the bits of its longitude and latitude (−0 as 0). */
function hashPoint(p: PBase): number {
  f64[0] = p.lng + 0;
  f64[1] = p.lat + 0;
  const h = Math.imul(u32[0] ^ Math.imul(u32[1], 0x9e3779b1), 0x85ebca6b);
  return h ^ Math.imul(u32[2] ^ Math.imul(u32[3], 0xc2b2ae35), 0x27d4eb2f);
}

const samePoint = (p: PBase, q: PBase) => p.lng === q.lng && p.lat === q.lat;

/**
 * Each segment's fate (ONCE, TWICE or OUT), by its place. A segment of no
 * length is OUT. With `pair`, two segments with the same two ends, in either
 * direction, are paired in the order they come: the first is TWICE, the
 * second OUT; a third occurrence starts a new pair (so k occurrences leave
 * ⌊k / 2⌋ TWICE and k mod 2 ONCE: the same k layers). Ends are compared by
 * longitude and latitude, exactly: the outline files cut neighbours along
 * the same vertices.
 */
export function pairSegments(a: readonly PBase[], b: readonly PBase[], pair: boolean): Uint8Array {
  const n = a.length;
  const fate = new Uint8Array(n);
  let cap = 16;
  while (cap < n * 2) cap *= 2;
  // Open addressing: a slot holds the first segment seen with its two ends
  // (−1: free); `open[s]` is the occurrence of those ends still unpaired.
  const slots = pair ? new Int32Array(cap).fill(-1) : null;
  const open = pair ? new Int32Array(cap) : null;
  for (let i = 0; i < n; i++) {
    const p = a[i];
    const q = b[i];
    if (samePoint(p, q)) {
      fate[i] = OUT;
      continue;
    }
    if (!slots || !open) continue;
    const sum = (hashPoint(p) + hashPoint(q)) | 0;
    let s = Math.imul(sum ^ (sum >>> 15), 0x2c1b3c6d) & (cap - 1);
    for (;;) {
      const first = slots[s];
      if (first < 0) {
        slots[s] = i;
        open[s] = i;
        break;
      }
      const fa = a[first];
      const fb = b[first];
      if ((samePoint(fa, p) && samePoint(fb, q)) || (samePoint(fa, q) && samePoint(fb, p))) {
        const mate = open[s];
        if (mate < 0) {
          open[s] = i;
        } else {
          fate[mate] = TWICE;
          fate[i] = OUT;
          open[s] = -1;
        }
        break;
      }
      s = (s + 1) & (cap - 1);
    }
  }
  return fate;
}

/**
 * The groups' segments in the lean layout, one buffer per regime asked for
 * (`origin`: what the mercator one is relative to), and the draw ranges: per
 * group, the segments drawn as they are, then (a group not depth-tested: a
 * raised one) those that stand for two, `twice` set. A range counts in
 * vertices, SEGMENT_VERTICES a segment, as the full layout's do; an empty
 * one is left out. The ranges come from the rings alone: the same whichever
 * regimes are packed.
 */
export function packLeanLines(
  groups: readonly SegmentGroup[],
  origin: readonly [number, number] | null,
  want: { merc: boolean; globe: boolean },
): {
  lines: Float32Array<ArrayBuffer> | null;
  gLines: Float32Array<ArrayBuffer> | null;
  ranges: LineRange[];
} {
  const fates = groups.map((g) => pairSegments(g.a, g.b, g.raised));
  let total = 0;
  for (const fate of fates) for (let i = 0; i < fate.length; i++) if (fate[i] !== OUT) total++;
  const lines = want.merc ? new Float32Array(total * LEAN_FLOATS) : null;
  const gLines = want.globe ? new Float32Array(total * G_LEAN_FLOATS) : null;
  const ox = origin ? origin[0] : 0;
  const oy = origin ? origin[1] : 0;
  const ranges: LineRange[] = [];
  let at = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const { width, alpha, raised, alt, a, b } = groups[gi];
    const fate = fates[gi];
    for (const pass of [ONCE, TWICE]) {
      const first = at;
      for (let i = 0; i < fate.length; i++) {
        if (fate[i] !== pass) continue;
        const p = a[i];
        const q = b[i];
        if (lines) {
          const o = at * LEAN_FLOATS;
          lines[o] = p.x - ox;
          lines[o + 1] = p.y - oy;
          lines[o + 2] = alt * p.zPerM;
          lines[o + 3] = q.x - ox;
          lines[o + 4] = q.y - oy;
          lines[o + 5] = alt * q.zPerM;
        }
        if (gLines) {
          putGlobeEnd(gLines, at * G_LEAN_FLOATS, p, alt);
          putGlobeEnd(gLines, at * G_LEAN_FLOATS + 9, q, alt);
        }
        at++;
      }
      if (at === first) continue;
      const range: LineRange = {
        width,
        alpha,
        raised,
        start: first * SEGMENT_VERTICES,
        count: (at - first) * SEGMENT_VERTICES,
      };
      if (pass === TWICE) range.twice = true;
      ranges.push(range);
    }
  }
  return { lines, gLines, ranges };
}

/** A segment's end in the globe layout, at `o`: absolute mercator at `alt`,
 *  ECEF on the ground, ECEF at `alt` — the full layout's values. */
function putGlobeEnd(out: Float32Array, o: number, p: PBase, alt: number) {
  out[o] = p.x;
  out[o + 1] = p.y;
  out[o + 2] = alt * p.zPerM;
  out[o + 3] = p.lo[0];
  out[o + 4] = p.lo[1];
  out[o + 5] = p.lo[2];
  out[o + 6] = p.lo[0] + alt * p.d[0];
  out[o + 7] = p.lo[1] + alt * p.d[1];
  out[o + 8] = p.lo[2] + alt * p.d[2];
}
