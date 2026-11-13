// The pending mark's pure pieces (pendingMark.ts): its meshes for one unit in
// each regime — the stroke in the boundary lines' own layout, the flat fill
// in the hover fill's —, where they stand, the fill left out past its vertex
// cap, the fade and the hover-fill threshold that draws a given opacity. No
// __TEST_TOOLS__ stub on purpose: the builder's import closure must not read
// it. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { baseOf } from "../lib/projection";
import {
  MARK_FADE_MS,
  MARK_FILL_MAX_VERTICES,
  buildMarkSet,
  fillThreshold,
  markLidFillM,
  markLidLineM,
  markOpacity,
  markVertexCount,
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
const BOTH = { stroke: true, fill: true };
const near = (a: number, b: number, eps = 1e-6) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test("a square's stroke: a quad per segment, in the boundary lines' layout", () => {
  const g = square();
  const set = buildMarkSet(g, "merc", 12, 8, BOTH)!;
  assert.equal(markVertexCount(g), 5);
  assert.equal(set.lineCount, 4 * 6);
  assert.equal(set.line.length, set.lineCount * 8);
  const a = baseOf(4, 45);
  const b = baseOf(5, 45);
  assert.deepEqual(set.origin, [a.x, a.y]);
  // The first vertex: A, then its other end B, the offset side, the geometric side.
  const v0 = Array.from(set.line.subarray(0, 8));
  assert.ok(near(v0[0], 0) && near(v0[1], 0));
  assert.ok(near(v0[2], 12 * a.zPerM));
  assert.ok(near(v0[3], b.x - a.x) && near(v0[4], b.y - a.y));
  assert.ok(near(v0[5], 12 * b.zPerM));
  assert.deepEqual(v0.slice(6), [1, 1]);
  // The six corners' sides, as the lines': A+ B+ B- A+ B- A-.
  const sides = Array.from({ length: 6 }, (_, i) => [set.line[i * 8 + 6], set.line[i * 8 + 7]]);
  assert.deepEqual(sides, [
    [1, 1],
    [-1, 1],
    [1, -1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ]);
});

test("its flat fill: two triangles at the fill's height, every distance 0", () => {
  const set = buildMarkSet(square(), "merc", 12, 8, BOTH)!;
  assert.equal(set.fillCount, 6);
  assert.equal(set.fill.length, 6 * 4);
  const a = baseOf(4, 45);
  for (let i = 0; i < set.fillCount; i++) {
    assert.equal(set.fill[i * 4 + 3], 0);
    assert.ok(set.fill[i * 4 + 2] > 0 && set.fill[i * 4 + 2] < 9 * a.zPerM * 1.1);
  }
});

test("the globe set is absolute: mercator, the ECEF ground, the ECEF at height", () => {
  const set = buildMarkSet(square(), "globe", 3000, 2000, BOTH)!;
  assert.deepEqual(set.origin, [0, 0]);
  assert.equal(set.line.length, set.lineCount * 20);
  assert.equal(set.fill.length, set.fillCount * 10);
  const a = baseOf(4, 45);
  const v = Array.from(set.line.subarray(0, 9));
  assert.ok(near(v[0], a.x) && near(v[1], a.y) && near(v[2], 3000 * a.zPerM));
  for (let k = 0; k < 3; k++) {
    assert.ok(near(v[3 + k], a.lo[k]));
    assert.ok(near(v[6 + k], a.lo[k] + 3000 * a.d[k]));
  }
  // The same vertex count and sides as the mercator set.
  const merc = buildMarkSet(square(), "merc", 3000, 2000, BOTH)!;
  assert.equal(set.lineCount, merc.lineCount);
  assert.equal(set.fillCount, merc.fillCount);
  assert.deepEqual([set.line[18], set.line[19]], [merc.line[6], merc.line[7]]);
  assert.equal(set.fill[9], 0);
});

test("only what is asked for is built", () => {
  const stroke = buildMarkSet(square(), "merc", 12, 8, { stroke: true, fill: false })!;
  assert.ok(stroke.lineCount > 0);
  assert.equal(stroke.fillCount, 0);
  assert.equal(stroke.fill.length, 0);
  const fill = buildMarkSet(square(), "globe", 12, 8, { stroke: false, fill: true })!;
  assert.equal(fill.lineCount, 0);
  assert.equal(fill.line.length, 0);
  assert.ok(fill.fillCount > 0);
});

test("a hole is kept out of the fill, and stroked", () => {
  const g: MarkGeometry = {
    type: "Polygon",
    coordinates: [ring(0, 0, 4), ring(1, 1, 2).reverse()],
  };
  const set = buildMarkSet(g, "merc", 12, 8, BOTH)!;
  assert.equal(set.lineCount, 8 * 6);
  // No triangle's centre falls in the hole.
  const at = (i: number) => [set.fill[i * 4], set.fill[i * 4 + 1]];
  const o = baseOf(0, 0);
  const lo = baseOf(1, 1);
  const hi = baseOf(3, 3);
  for (let t = 0; t < set.fillCount; t += 3) {
    const cx = (at(t)[0] + at(t + 1)[0] + at(t + 2)[0]) / 3 + o.x;
    const cy = (at(t)[1] + at(t + 1)[1] + at(t + 2)[1]) / 3 + o.y;
    const inHole =
      cx > Math.min(lo.x, hi.x) &&
      cx < Math.max(lo.x, hi.x) &&
      cy > Math.min(lo.y, hi.y) &&
      cy < Math.max(lo.y, hi.y);
    assert.equal(inHole, false);
  }
});

test("every polygon of a unit is marked: an island as the mainland", () => {
  const g: MarkGeometry = {
    type: "MultiPolygon",
    coordinates: [[ring(0, 0, 2)], [ring(5, 5, 0.1)]],
  };
  const set = buildMarkSet(g, "merc", 12, 8, BOTH)!;
  assert.equal(set.lineCount, 8 * 6);
  assert.equal(set.fillCount, 12);
});

test("nothing to draw: null", () => {
  assert.equal(buildMarkSet({ type: "Polygon", coordinates: [] }, "merc", 12, 8, BOTH), null);
  assert.equal(buildMarkSet({}, "globe", 12, 8, BOTH), null);
});

test("past the vertex cap the fill is left out, the stroke stands", () => {
  const n = MARK_FILL_MAX_VERTICES + 10;
  const big: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    big.push([2 + Math.cos(t), 46 + Math.sin(t)]);
  }
  big.push(big[0]);
  const set = buildMarkSet({ type: "Polygon", coordinates: [big] }, "merc", 12, 8, BOTH)!;
  assert.equal(set.fillCount, 0);
  assert.equal(set.lineCount, n * 6);
});

test("on a lid: the fill just over it, the stroke over the fill", () => {
  assert.ok(markLidFillM(1000) > 1000);
  assert.ok(markLidLineM(1000) > markLidFillM(1000));
});

test("the mark is whole while held, then fades to nothing in its time", () => {
  assert.equal(markOpacity(5000, 0), 1);
  assert.equal(markOpacity(1000, 1000), 1);
  assert.ok(near(markOpacity(1000 + MARK_FADE_MS / 2, 1000), 0.5));
  assert.equal(markOpacity(1000 + MARK_FADE_MS, 1000), 0);
  assert.equal(markOpacity(1000 + 10 * MARK_FADE_MS, 1000), 0);
  // A clock read before the fade began (two clocks a frame apart): whole.
  assert.equal(markOpacity(990, 1000), 1);
});

test("the hover-fill threshold draws the opacity asked for", () => {
  // The fill program's own formula for a vertex of distance 0.
  const smoothstep = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const drawn = (T: number) => 1 - smoothstep(T - 0.12, T, 0);
  for (const share of [0, 0.1, 0.35, 0.5, 0.7, 0.9, 1]) {
    assert.ok(near(drawn(fillThreshold(share)), share, 1e-9), String(share));
  }
  assert.ok(near(fillThreshold(1), 0.12));
  assert.equal(fillThreshold(0), 0);
  // Out of range: clamped.
  assert.equal(fillThreshold(-1), 0);
  assert.ok(near(fillThreshold(2), 0.12));
});
