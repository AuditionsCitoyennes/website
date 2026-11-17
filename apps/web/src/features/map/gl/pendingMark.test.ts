// The pending mark's pure pieces (pendingMark.ts): its meshes for one unit in
// each regime — the loading line, one record per segment with the share of
// its ring's length reached at each end, and the flat fill in the hover
// fill's layout, bisected on the globe —, the height they are built at,
// where a unit's are built, and the line's and the fill's small functions of
// time. No __TEST_TOOLS__ stub on purpose: the builder's import closure must
// not read it. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { baseOf } from "../lib/projection";
import {
  G_MARK_FILL_FLOATS,
  G_MARK_LINE_FLOATS,
  MARK_CREEP_FREEZE_MS,
  MARK_CREEP_MAX,
  MARK_FILL_FLOATS,
  MARK_FILL_MAX_EDGE_DEG,
  MARK_LINE_FLOATS,
  MARK_PAGE_MAX_SPAN_DEG,
  MARK_PAGE_MAX_VERTICES,
  MARK_REF_M,
  buildMark,
  buildMarkFill,
  buildMarkLine,
  creepCeil,
  creepShown,
  easeStep,
  fadeAlpha,
  fillThreshold,
  markBuildPlace,
  markLidFillM,
  markLidLineM,
  ringVertexCount,
  type MarkGeometry,
} from "./pendingMark";

/** A closed square ring, `s` degrees wide, from (x, y). */
const ring = (x: number, y: number, s: number): [number, number][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];
const square = (x = 4, y = 45, s = 1): MarkGeometry => ({
  type: "Polygon",
  coordinates: [ring(x, y, s)],
});
const near = (a: number, b: number, eps = 1e-6) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test("a square's line in the flat view: a record per segment, relative to its first vertex", () => {
  const g = square();
  const line = buildMarkLine(g, "merc")!;
  assert.equal(MARK_LINE_FLOATS, 8);
  assert.equal(ringVertexCount(g), 5);
  assert.equal(line.segCount, 4);
  assert.equal(line.segs.length, 4 * MARK_LINE_FLOATS);
  const a = baseOf(4, 45);
  const b = baseOf(5, 45);
  assert.deepEqual(line.origin, [a.x, a.y]);
  // The first segment: A, then B, at the reference height, then the two lengths.
  const s0 = Array.from(line.segs.subarray(0, 8));
  assert.ok(near(s0[0], 0) && near(s0[1], 0));
  assert.ok(near(s0[2], MARK_REF_M * a.zPerM));
  assert.ok(near(s0[3], b.x - a.x) && near(s0[4], b.y - a.y));
  assert.ok(near(s0[5], MARK_REF_M * b.zPerM));
  assert.equal(s0[6], 0);
  assert.ok(s0[7] > 0 && s0[7] < 1);
});

test("the lengths run from 0 to 1 along each ring, each segment starting where the one before ended", () => {
  const g: MarkGeometry = {
    type: "MultiPolygon",
    coordinates: [[ring(4, 45, 1), ring(4.4, 45.4, 0.2)], [ring(10, 40, 3)]],
  };
  for (const regime of ["merc", "globe"] as const) {
    const line = buildMarkLine(g, regime)!;
    const stride = regime === "merc" ? MARK_LINE_FLOATS : G_MARK_LINE_FLOATS;
    assert.equal(line.segCount, 12);
    assert.equal(line.segs.length, 12 * stride);
    for (let r = 0; r < 3; r++) {
      let prev = 0;
      for (let i = 0; i < 4; i++) {
        const o = (r * 4 + i) * stride;
        const lenA = line.segs[o + stride - 2];
        const lenB = line.segs[o + stride - 1];
        assert.equal(lenA, prev, `${regime} ring ${r} segment ${i}: starts where the last ended`);
        assert.ok(lenB > lenA, "monotone");
        prev = lenB;
      }
      assert.ok(near(prev, 1), `${regime} ring ${r} ends at 1`);
    }
  }
});

test("the globe's line: absolute, each end as mercator, ECEF on the ground and at the reference height", () => {
  const line = buildMarkLine(square(), "globe")!;
  assert.equal(G_MARK_LINE_FLOATS, 20);
  assert.deepEqual(line.origin, [0, 0]);
  const a = baseOf(4, 45);
  const s0 = Array.from(line.segs.subarray(0, 9));
  assert.ok(near(s0[0], a.x) && near(s0[1], a.y) && near(s0[2], MARK_REF_M * a.zPerM));
  for (let k = 0; k < 3; k++) {
    assert.ok(near(s0[3 + k], a.lo[k]));
    assert.ok(near(s0[6 + k], a.lo[k] + MARK_REF_M * a.d[k]));
  }
});

test("the reference height scales to any height: 12 m of it is the ground line's", () => {
  const line = buildMarkLine(square(), "merc")!;
  const a = baseOf(4, 45);
  const scale = 12 / MARK_REF_M;
  assert.ok(near(line.segs[2] * scale, 12 * a.zPerM, 1e-5));
  assert.ok(near(markLidFillM(1000), 1001));
  assert.ok(near(markLidLineM(1000), 1002));
});

test("the flat view's fill: plain earcut, holes kept, in the hover fill's layout", () => {
  const plain = buildMarkFill(square(), "merc")!;
  assert.equal(MARK_FILL_FLOATS, 4);
  assert.equal(plain.fillCount, 6); // two triangles
  assert.equal(plain.fill.length, 6 * MARK_FILL_FLOATS);
  for (let i = 0; i < plain.fillCount; i++) assert.equal(plain.fill[i * 4 + 3], 0); // no sweep
  const a = baseOf(4, 45);
  assert.deepEqual(plain.origin, [a.x, a.y]);
  // Every triangle vertex is a corner of the square, at the reference height.
  const xs = new Set(Array.from({ length: 6 }, (_, i) => Math.round(plain.fill[i * 4] * 1e7)));
  assert.equal(xs.size, 2);
  const holed = buildMarkFill(
    { type: "Polygon", coordinates: [ring(4, 45, 1), ring(4.4, 45.4, 0.2)] },
    "merc",
  )!;
  assert.equal(holed.fillCount, 8 * 3); // a square with a square hole: eight triangles
  // The same size on a 40° square: the flat view is never bisected.
  assert.equal(buildMarkFill(square(0, 0, 40), "merc")!.fillCount, 6);
});

/** The longest edge of a globe fill's triangles, degrees of arc, read back from ECEF. */
function longestEdgeDeg(fill: Float32Array, count: number): number {
  const R = 8192 / Math.PI / 2;
  let worst = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    for (let c = 0; c < 3; c++) {
      const p = (t + c) * G_MARK_FILL_FLOATS + 3;
      const q = (t + ((c + 1) % 3)) * G_MARK_FILL_FLOATS + 3;
      const chord = Math.hypot(
        fill[p] - fill[q],
        fill[p + 1] - fill[q + 1],
        fill[p + 2] - fill[q + 2],
      );
      worst = Math.max(worst, (2 * Math.asin(Math.min(1, chord / (2 * R))) * 180) / Math.PI);
    }
  }
  return worst;
}

test("the globe's fill: no edge longer than the cap on a 40° square, nothing added on a 1° square", () => {
  assert.equal(G_MARK_FILL_FLOATS, 10);
  const small = buildMarkFill(square(), "globe")!;
  assert.equal(small.fillCount, 6);
  assert.equal(small.fill.length, 6 * G_MARK_FILL_FLOATS);
  const big = buildMarkFill(square(0, 0, 40), "globe")!;
  assert.ok(big.fillCount > 6 * 100, `${big.fillCount} vertices`);
  assert.equal(big.fillCount % 3, 0);
  const worst = longestEdgeDeg(big.fill, big.fillCount);
  assert.ok(worst <= MARK_FILL_MAX_EDGE_DEG * 1.01, `longest edge ${worst}°`);
  // Each vertex: mercator, ECEF on the ground, ECEF at the reference height, distance 0.
  const b = baseOf(0, 0);
  const at = (i: number) => Array.from(big.fill.subarray(i * 10, i * 10 + 10));
  const corner = Array.from({ length: big.fillCount }, (_, i) => at(i)).find(
    (v) => near(v[0], b.x) && near(v[1], b.y),
  )!;
  assert.ok(corner, "the square's corner is a vertex of the fill");
  assert.ok(near(corner[2], MARK_REF_M * b.zPerM));
  for (let k = 0; k < 3; k++) assert.ok(near(corner[6 + k], b.lo[k] + MARK_REF_M * b.d[k], 1e-5));
  assert.equal(corner[9], 0);
});

test("the bisection leaves no crack: every edge inside the fill is shared by two triangles", () => {
  const big = buildMarkFill(square(0, 0, 40), "globe")!;
  const key = (i: number) =>
    `${big.fill[i * 10 + 3].toFixed(4)},${big.fill[i * 10 + 4].toFixed(4)},${big.fill[i * 10 + 5].toFixed(4)}`;
  const edges = new Map<string, number>();
  for (let t = 0; t + 2 < big.fillCount; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = key(t + c);
      const b = key(t + ((c + 1) % 3));
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  let alone = 0;
  for (const n of edges.values()) {
    assert.ok(n <= 2, "an edge belongs to two triangles at most");
    if (n === 1) alone++;
  }
  // The edges used once are the square's own boundary: 4 sides of 40°, cut to
  // at most 2° — a crack inside would add edges used once.
  assert.ok(alone >= 4 * 20 && alone <= 4 * 64, `${alone} boundary edges`);
});

test("both meshes from one projection; a geometry with no segment gives nothing", () => {
  const both = buildMark(square(), "globe")!;
  assert.equal(both.line.segCount, 4);
  assert.equal(both.fill.fillCount, 6);
  const empty: MarkGeometry = { type: "Polygon", coordinates: [] };
  assert.equal(buildMark(empty, "merc"), null);
  assert.equal(buildMarkLine(empty, "merc"), null);
  assert.equal(buildMarkFill(empty, "globe"), null);
  assert.equal(ringVertexCount(empty), 0);
  assert.equal(buildMarkLine({ type: "Point", coordinates: [1, 2] }, "merc"), null);
});

test("where a unit's meshes are built: small on the page, large or wide on the globe off the frame", () => {
  assert.equal(markBuildPlace(MARK_PAGE_MAX_VERTICES, 5, "merc"), "page");
  assert.equal(markBuildPlace(MARK_PAGE_MAX_VERTICES + 1, 5, "merc"), "off-frame");
  assert.equal(markBuildPlace(300, MARK_PAGE_MAX_SPAN_DEG, "globe"), "page");
  assert.equal(markBuildPlace(300, MARK_PAGE_MAX_SPAN_DEG + 1, "globe"), "off-frame");
  assert.equal(markBuildPlace(300, 170, "merc"), "page"); // the flat view is never bisected
});

test("the line's ease: from where it is to its step, ease-out, exact at both ends", () => {
  assert.equal(easeStep(0.2, 0.6, 0), 0.2);
  assert.equal(easeStep(0.2, 0.6, 1), 0.6);
  assert.equal(easeStep(0.2, 0.6, 3), 0.6);
  assert.equal(easeStep(0.2, 0.6, -1), 0.2);
  const mid = easeStep(0.2, 0.6, 0.5);
  assert.ok(mid > 0.4 && mid < 0.6); // past the middle: ease-out
});

test("the creep: toward a ceiling short of the end, never under its base, frozen after a while", () => {
  for (const base of [0, 0.25, 0.54, 0.8, 0.9, 0.95]) {
    const ceil = creepCeil(base);
    assert.ok(ceil >= base, `ceil ${ceil} ≥ base ${base}`);
    assert.ok(ceil <= Math.max(base, MARK_CREEP_MAX));
    let last = base;
    for (let ms = 0; ms <= 10_000; ms += 250) {
      const v = creepShown(base, ms);
      assert.ok(v >= last - 1e-12 && v <= ceil, `${base} at ${ms}: ${v}`);
      last = v;
    }
    assert.equal(creepShown(base, MARK_CREEP_FREEZE_MS), creepShown(base, 60_000)); // frozen
    assert.equal(creepShown(base, 0), base);
    assert.equal(creepShown(base, -5), base);
  }
  assert.equal(creepCeil(0), 0.5);
  assert.equal(creepCeil(0.95), 0.95); // past the cap already: no creep at all
});

test("a fade: 1 until it starts, linear, 0 from its end — and at once without a time", () => {
  assert.equal(fadeAlpha(5000, 0, 117), 1); // not started
  assert.equal(fadeAlpha(1000, 1000, 117), 1);
  assert.ok(near(fadeAlpha(1058.5, 1000, 117), 0.5));
  assert.equal(fadeAlpha(1117, 1000, 117), 0);
  assert.equal(fadeAlpha(1500, 1000, 117), 0);
  assert.equal(fadeAlpha(1000, 1000, 0), 0); // reduced motion: gone in one frame
});

test("the fill's threshold draws the asked share of the hover fill's opacity", () => {
  // The hover fill's fragment: (1 − smoothstep(T − 0.12, T, d)) × 0.6, at d = 0.
  const drawn = (T: number) => {
    const x = Math.min(1, Math.max(0, (0 - (T - 0.12)) / 0.12));
    return 1 - x * x * (3 - 2 * x);
  };
  for (const share of [0, 0.1, 0.42, 0.7, 1]) {
    assert.ok(Math.abs(drawn(fillThreshold(share)) - share) < 1e-9, `share ${share}`);
  }
  assert.equal(fillThreshold(1), 0.12);
  assert.equal(fillThreshold(0), 0);
  assert.equal(fillThreshold(7), 0.12);
});
