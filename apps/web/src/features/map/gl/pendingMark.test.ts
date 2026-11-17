// The pending mark's pure pieces (pendingMark.ts): its meshes for one unit in
// each regime — the loading line, one record per segment with the share of
// the whole boundary's length reached at each end (the rings one after the
// other, the longest first) and its ring's depth (what caps the line's width
// around an islet), the flat fill in the hover fill's layout, bisected on
// the globe, and a large unit's thinned stand-in —, the height they are
// built at, where a unit's are built, and the line's and the fill's small
// functions of time. No __TEST_TOOLS__ stub on purpose: the builder's import closure must
// not read it. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { baseOf } from "../lib/projection";
import {
  G_MARK_FILL_FLOATS,
  G_MARK_LINE_FLOATS,
  MARK_CREEP_FREEZE_MS,
  MARK_CREEP_LEAD,
  MARK_CREEP_MAX,
  MARK_FILL_FLOATS,
  MARK_FILL_MAX_EDGE_DEG,
  MARK_LINE_FLOATS,
  MARK_LINE_FULL_MS,
  MARK_LINE_FULL_PX,
  MARK_LINE_MIN_SHARE,
  MARK_LINE_RING_SHARE,
  MARK_LINE_WIDTH,
  MARK_PAGE_MAX_SPAN_DEG,
  MARK_PAGE_MAX_VERTICES,
  MARK_REF_M,
  MARK_STANDIN_VERTICES,
  MARK_STEP_MS,
  buildMark,
  buildMarkFill,
  buildMarkLine,
  buildMarkStandIn,
  creepLead,
  creepShown,
  easeStep,
  lineEaseMs,
  lineRun,
  unfillEnd,
  fadeAlpha,
  fillThreshold,
  markBuildPlace,
  markLidFillM,
  markLidLineM,
  markLineWidth,
  ringVertexCount,
  unfillAlpha,
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
  assert.equal(MARK_LINE_FLOATS, 9);
  assert.equal(ringVertexCount(g), 5);
  assert.equal(line.segCount, 4);
  assert.equal(line.segs.length, 4 * MARK_LINE_FLOATS);
  const a = baseOf(4, 45);
  const b = baseOf(5, 45);
  assert.deepEqual(line.origin, [a.x, a.y]);
  // The first segment: A, then B, at the reference height, then the two
  // lengths and the ring's depth.
  const s0 = Array.from(line.segs.subarray(0, 9));
  assert.ok(near(s0[0], 0) && near(s0[1], 0));
  assert.ok(near(s0[2], MARK_REF_M * a.zPerM));
  assert.ok(near(s0[3], b.x - a.x) && near(s0[4], b.y - a.y));
  assert.ok(near(s0[5], MARK_REF_M * b.zPerM));
  assert.equal(s0[6], 0);
  assert.ok(s0[7] > 0 && s0[7] < 1);
  // One ring, the whole boundary: its area over its perimeter squared. A
  // square's is 1/16 (a little off: a degree is not square on the map).
  assert.ok(s0[8] > 0.055 && s0[8] < 0.0625, `depth ${s0[8]}`);
  for (let i = 1; i < 4; i++) assert.equal(line.segs[i * MARK_LINE_FLOATS + 8], s0[8]);
});

test("a ring's depth: its area over its perimeter, as a share of the whole boundary — small for an islet, smaller still for a ragged one, the same in both regimes", () => {
  // A 4° square, a 0.2° islet, and a comb as long as the islet is wide.
  const comb: [number, number][] = [[20, 0]];
  for (let i = 0; i < 10; i++) {
    comb.push([20 + i * 0.02 + 0.01, 0.2], [20 + i * 0.02 + 0.02, 0]);
  }
  comb.push([20, 0]);
  const g: MarkGeometry = {
    type: "MultiPolygon",
    coordinates: [[ring(0, 0, 4)], [ring(10, 0, 0.2)], [comb]],
  };
  const depthOf = (regime: "merc" | "globe") => {
    const line = buildMarkLine(g, regime)!;
    const stride = regime === "merc" ? MARK_LINE_FLOATS : G_MARK_LINE_FLOATS;
    return [0, 4, 8].map((seg) => line.segs[seg * stride + stride - 1]);
  };
  const [big, islet, ragged] = depthOf("merc");
  assert.ok(big > 0.04, `the mainland ${big}`);
  // Twenty times smaller a ring: about twenty times less deep.
  assert.ok(near(big / islet, 20, 0.1), `${big / islet}`);
  // As wide as the islet, five times its perimeter, half its area.
  assert.ok(ragged < islet / 2, `${ragged} against ${islet}`);
  const globe = depthOf("globe");
  for (const [i, d] of [big, islet, ragged].entries()) assert.ok(near(globe[i], d, 1e-5));
  // What the shader makes of it: at 100 px a degree the mainland's line has
  // room for the full width, the islet's for about a pixel.
  const total = 16 + 0.8 + 4.03; // degrees of boundary, about
  const widthPx = (depth: number) => depth * total * 100 * MARK_LINE_RING_SHARE;
  assert.ok(widthPx(big) > MARK_LINE_WIDTH * 2);
  assert.ok(widthPx(islet) > 1.5 && widthPx(islet) < 3, `${widthPx(islet)} px`);
  // A ring with no surface carries no line.
  const flat: MarkGeometry = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [0, 0],
      ],
    ],
  };
  assert.equal(buildMarkLine(flat, "merc")!.segs[8], 0);
});

test("the lengths run from 0 to 1 along the whole boundary: one ring after the other, the longest first, each segment starting where the one before ended", () => {
  // A 1° ring, a 0.2° one (a hole) and a 3° one: drawn 3°, then 1°, then 0.2°.
  const g: MarkGeometry = {
    type: "MultiPolygon",
    coordinates: [[ring(4, 45, 1), ring(4.4, 45.4, 0.2)], [ring(10, 40, 3)]],
  };
  for (const regime of ["merc", "globe"] as const) {
    const line = buildMarkLine(g, regime)!;
    const stride = regime === "merc" ? MARK_LINE_FLOATS : G_MARK_LINE_FLOATS;
    assert.equal(line.segCount, 12);
    assert.equal(line.segs.length, 12 * stride);
    // The records stay in the outline's order; only their lengths are ordered.
    const ends = [0, 1, 2].map((r) => {
      let prev = line.segs[r * 4 * stride + stride - 3];
      const from = prev;
      for (let i = 0; i < 4; i++) {
        const o = (r * 4 + i) * stride;
        const lenA = line.segs[o + stride - 3];
        const lenB = line.segs[o + stride - 2];
        assert.equal(lenA, prev, `${regime} ring ${r} segment ${i}: starts where the last ended`);
        assert.ok(lenB > lenA, "monotone");
        prev = lenB;
      }
      return { from, to: prev };
    });
    const [one, small, three] = ends;
    assert.equal(three.from, 0); // the longest ring first
    assert.ok(near(one.from, three.to), `${regime}: the 1° ring starts where the 3° one ends`);
    assert.ok(near(small.from, one.to), `${regime}: the smallest last`);
    assert.ok(near(small.to, 1), `${regime}: the boundary ends at 1`);
    // Each ring's share is its share of the length: the islet's is small.
    assert.ok(three.to > 0.6 && small.to - small.from < 0.06);
  }
});

test("at a low progress only the longest ring is reached: no dash on every island", () => {
  const g: MarkGeometry = {
    type: "MultiPolygon",
    coordinates: [[ring(0, 0, 0.1)], [ring(5, 5, 4)], [ring(1, 1, 0.1)], [ring(2, 2, 0.1)]],
  };
  const line = buildMarkLine(g, "merc")!;
  const reached = (progress: number) => {
    const rings = new Set<number>();
    for (let i = 0; i < line.segCount; i++) {
      if (line.segs[i * MARK_LINE_FLOATS + 6] < progress) rings.add(Math.floor(i / 4));
    }
    return [...rings];
  };
  assert.deepEqual(reached(0.1), [1]);
  assert.deepEqual(reached(0.9), [1]);
  assert.deepEqual(reached(1), [0, 1, 2, 3]); // ties: as the outline lists them
});

test("the globe's line: absolute, each end as mercator, ECEF on the ground and at the reference height", () => {
  const line = buildMarkLine(square(), "globe")!;
  assert.equal(G_MARK_LINE_FLOATS, 21);
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

test("where a unit's meshes are built: small on the page, wide on the globe there too with a plain fill, large off the frame", () => {
  assert.equal(markBuildPlace(MARK_PAGE_MAX_VERTICES, 5, "merc"), "page");
  assert.equal(markBuildPlace(MARK_PAGE_MAX_VERTICES + 1, 5, "merc"), "off-frame");
  assert.equal(markBuildPlace(300, MARK_PAGE_MAX_SPAN_DEG, "globe"), "page");
  assert.equal(markBuildPlace(300, MARK_PAGE_MAX_SPAN_DEG + 1, "globe"), "page-plain");
  assert.equal(markBuildPlace(300, 170, "merc"), "page"); // the flat view is never bisected
  assert.equal(markBuildPlace(MARK_PAGE_MAX_VERTICES + 1, 170, "globe"), "off-frame");
});

test("a plain globe fill: earcut's own triangles, the same edge as the bisected one", () => {
  const g = square(0, 0, 40);
  const plain = buildMarkFill(g, "globe", false)!;
  const fine = buildMarkFill(g, "globe")!;
  assert.equal(plain.fillCount, 6); // two triangles
  assert.ok(fine.fillCount > 600);
  // The flat view is never bisected: the flag changes nothing there.
  assert.equal(buildMarkFill(g, "merc", false)!.fillCount, buildMarkFill(g, "merc")!.fillCount);
  assert.equal(buildMark(g, "globe", false)!.fill.fillCount, 6);
});

test("the line's width: thinner around a unit small on screen, never under its floor, never over the full width", () => {
  assert.equal(markLineWidth(10, 6), MARK_LINE_WIDTH); // 910 px wide: the full width
  const px = (span: number, zoom: number) => (span / 360) * 512 * 2 ** zoom;
  assert.ok(near(px(1, 5), 45.5, 1e-2));
  assert.equal(markLineWidth(1, 5), MARK_LINE_WIDTH * MARK_LINE_MIN_SHARE); // 45 px: the floor
  const mid = markLineWidth(1, 7); // about 182 px
  assert.ok(mid > MARK_LINE_WIDTH * MARK_LINE_MIN_SHARE && mid < MARK_LINE_WIDTH);
  assert.ok(near(markLineWidth(1, 7) / MARK_LINE_WIDTH, px(1, 7) / MARK_LINE_FULL_PX));
  assert.equal(markLineWidth(Number.NaN, 5), MARK_LINE_WIDTH);
  // Over a boundary line (0.9 to 1.7), and no band: 3 px drawn with its soft edge.
  assert.ok(MARK_LINE_WIDTH > 1.7 && MARK_LINE_WIDTH <= 2);
  assert.ok(MARK_LINE_WIDTH * MARK_LINE_MIN_SHARE >= 1);
});

test("a large unit's stand-in: its outline thinned to about 1,500 vertices, filled plain, small rings dropped", () => {
  const circle = (x: number, y: number, r: number, n: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const a = ((i % n) / n) * 2 * Math.PI;
      out.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
    }
    return out;
  };
  // A mainland with a lake, a large island, an islet of a few vertices.
  const g: MarkGeometry = {
    type: "MultiPolygon",
    coordinates: [
      [circle(0, 45, 5, 9000), circle(0, 45, 1, 600)],
      [circle(20, 45, 1, 2400)],
      [circle(30, 45, 0.1, 12)],
    ],
  };
  const vertices = ringVertexCount(g);
  assert.ok(vertices > MARK_PAGE_MAX_VERTICES);
  const k = Math.ceil(vertices / MARK_STANDIN_VERTICES); // every 9th vertex
  for (const regime of ["merc", "globe"] as const) {
    const fill = buildMarkStandIn(g, regime)!;
    const stride = regime === "merc" ? MARK_FILL_FLOATS : G_MARK_FILL_FLOATS;
    assert.equal(fill.fill.length, fill.fillCount * stride);
    // Earcut's count for the rings kept: n − 2 triangles a ring, + 2 a hole.
    const kept = [9000, 600, 2400].map((n) => Math.ceil(n / k));
    assert.equal(fill.fillCount, 3 * (kept[0] + kept[1] + kept[2] - 2));
    assert.ok(fill.fillCount <= 3 * MARK_STANDIN_VERTICES);
    assert.equal(fill.fillCount, buildMarkStandIn(g, regime, vertices)!.fillCount);
  }
  // Nearly the same surface as the real fill (flat view: the triangles' area).
  const area = (f: { fill: Float32Array; fillCount: number }) => {
    let a = 0;
    for (let t = 0; t < f.fillCount; t += 3) {
      const [x0, y0, x1, y1, x2, y2] = [0, 1, 2].flatMap((c) => [
        f.fill[(t + c) * MARK_FILL_FLOATS],
        f.fill[(t + c) * MARK_FILL_FLOATS + 1],
      ]);
      a += Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
    }
    return a;
  };
  const real = area(buildMarkFill(g, "merc")!);
  assert.ok(near(area(buildMarkStandIn(g, "merc")!), real, 1e-3));
  // A small unit's is its own outline, whole.
  assert.equal(buildMarkStandIn(square(), "merc")!.fillCount, 6);
  // Nothing left to fill: null.
  assert.equal(buildMarkStandIn({ type: "Polygon", coordinates: [] }, "merc"), null);
  assert.equal(buildMarkStandIn({ type: "Point", coordinates: [1, 2] }, "globe"), null);
  assert.equal(buildMarkStandIn(g, "merc", 10_000_000), null); // thinned to nothing
});

test("the line's ease: from where it is to its step, ease-out, exact at both ends", () => {
  assert.equal(easeStep(0.2, 0.6, 0), 0.2);
  assert.equal(easeStep(0.2, 0.6, 1), 0.6);
  assert.equal(easeStep(0.2, 0.6, 3), 0.6);
  assert.equal(easeStep(0.2, 0.6, -1), 0.2);
  const mid = easeStep(0.2, 0.6, 0.5);
  assert.ok(mid > 0.4 && mid < 0.6); // past the middle: ease-out
});

test("the creep: a small lead on top of the real value, frozen after a while, never the end", () => {
  assert.equal(creepLead(0), 0);
  assert.equal(creepLead(-5), 0);
  let last = 0;
  for (let ms = 0; ms <= 10_000; ms += 250) {
    const lead = creepLead(ms);
    assert.ok(lead >= last && lead < MARK_CREEP_LEAD, `${ms}: ${lead}`);
    last = lead;
  }
  assert.equal(creepLead(MARK_CREEP_FREEZE_MS), creepLead(60_000)); // frozen
  assert.ok(creepLead(MARK_CREEP_FREEZE_MS) > MARK_CREEP_LEAD * 0.9);
  assert.ok(MARK_CREEP_LEAD <= 0.08); // a few hundredths of the boundary
  for (const real of [0, 0.164, 0.25, 0.54, 0.8, 0.88, 0.9, 0.95]) {
    for (let ms = 0; ms <= 10_000; ms += 250) {
      const v = creepShown(real, ms);
      // Never under the real value, never more than the lead past it.
      assert.ok(v >= real && v <= real + MARK_CREEP_LEAD, `${real} at ${ms}: ${v}`);
      assert.ok(v <= Math.max(real, MARK_CREEP_MAX));
    }
    assert.equal(creepShown(real, 0), real);
  }
  // The lead is the same whatever the real value: a real step of any length
  // moves the line by that length.
  assert.ok(near(creepShown(0.4, 2000) - creepShown(0.164, 2000), 0.4 - 0.164));
  assert.equal(creepShown(0.95, 4000), 0.95); // past the cap already: no lead at all
});

test("a fade: 1 until it starts, linear, 0 from its end — and at once without a time", () => {
  assert.equal(fadeAlpha(5000, 0, 117), 1); // not started
  assert.equal(fadeAlpha(1000, 1000, 117), 1);
  assert.ok(near(fadeAlpha(1058.5, 1000, 117), 0.5));
  assert.equal(fadeAlpha(1117, 1000, 117), 0);
  assert.equal(fadeAlpha(1500, 1000, 117), 0);
  // No time: a plain step at its start (reduced motion).
  assert.equal(fadeAlpha(1000, 1000, 0), 0);
  assert.equal(fadeAlpha(999, 1000, 0), 1);
});

test("the unfill: linear, down to its floor until the rise is cleared, then on to nothing", () => {
  assert.equal(unfillAlpha(65_000, 0, 100), 1); // not begun
  assert.equal(unfillAlpha(59_900, 60_000, 100), 1); // begins later (the line first)
  assert.ok(near(unfillAlpha(60_040, 60_000, 100), 0.6)); // linear
  assert.equal(unfillAlpha(60_100, 60_000, 100), 0);
  // A floor: held until the go, then the same speed from where it stood.
  assert.ok(near(unfillAlpha(60_050, 60_000, 100, 0.25), 0.5));
  assert.equal(unfillAlpha(60_075, 60_000, 100, 0.25), 0.25);
  assert.equal(unfillAlpha(64_000, 60_000, 100, 0.25), 0.25);
  assert.equal(unfillAlpha(60_300, 60_000, 100, 0.25, 60_300), 0.25);
  assert.ok(near(unfillAlpha(60_310, 60_000, 100, 0.25, 60_300), 0.15));
  assert.equal(unfillAlpha(60_325, 60_000, 100, 0.25, 60_300), 0);
  assert.equal(unfillEnd(60_000, 100, 0.25, 60_300), 60_325);
  // The go before the floor: the fade runs through, as with no floor.
  assert.ok(near(unfillAlpha(60_090, 60_000, 100, 0.25, 60_020), 0.1));
  assert.equal(unfillEnd(60_000, 100, 0.25, 60_020), 60_100);
  // The go before the fade began (the commit came while the line still ran):
  // the fade is whole at its start and runs through.
  assert.equal(unfillAlpha(60_556, 60_556, 100, 0.25, 60_466), 1);
  assert.ok(near(unfillAlpha(60_606, 60_556, 100, 0.25, 60_466), 0.5));
  assert.equal(unfillEnd(60_556, 100, 0.25, 60_466), 60_656);
  // A plain step (reduced motion): whole until its time, no floor.
  assert.equal(unfillAlpha(60_000, 60_000, 0, 0.25), 0);
  assert.equal(unfillAlpha(59_990, 60_000, 0, 0.25), 1);
  assert.equal(unfillEnd(60_000, 0, 0.25, 60_500), 60_000);
});

test("the line's run: a constant speed, the whole boundary in MARK_LINE_FULL_MS, a step never under MARK_STEP_MS", () => {
  assert.ok(near(lineEaseMs(0, 0.27), MARK_STEP_MS)); // a small step is not rushed
  assert.ok(near(lineEaseMs(0, 0.5), MARK_LINE_FULL_MS / 2));
  assert.ok(near(lineEaseMs(0, 0.5, 280, 100), 140));
  assert.ok(MARK_LINE_FULL_MS >= 250 && MARK_LINE_FULL_MS <= 300);
  assert.equal(lineEaseMs(0, 1), MARK_LINE_FULL_MS);
  assert.equal(lineEaseMs(0.95, 1), MARK_STEP_MS);
  assert.equal(lineEaseMs(0.4, 0.4), MARK_STEP_MS);
  assert.equal(lineRun(0.2, 0.6, 0), 0.2);
  assert.ok(near(lineRun(0.2, 0.6, 0.25), 0.3));
  assert.ok(near(lineRun(0.2, 0.6, 0.5), 0.4));
  assert.equal(lineRun(0.2, 0.6, 1), 0.6);
  assert.equal(lineRun(0.2, 0.6, 7), 0.6);
  assert.equal(lineRun(0.2, 0.6, -1), 0.2);
  // No frame adds more than its own time's share of the boundary.
  for (const [from, to] of [
    [0, 1],
    [0.3, 0.9],
    [0.9, 1],
  ]) {
    const ms = lineEaseMs(from, to);
    assert.ok((to - from) / ms <= 1 / MARK_LINE_FULL_MS + 1e-12);
  }
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
