// The flat view's grey sheet, cut (tintSheet.ts): the world with the
// selection's outer rings as holes and its enclaves greyed back in, relative
// to a vertex of the selection. Checked by area (the triangles cover the
// three world copies minus the selection), by point (inside a hole: no
// triangle; inside an enclave: one), at the poles and across ±180°. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { baseOf } from "../lib/mercator";
import { cutTintSheet, type MaskGeom } from "./tintSheet";

const ring = (x: number, y: number, s: number): [number, number][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];
const square = (x: number, y: number, s: number): MaskGeom => ({
  type: "Polygon",
  coordinates: [ring(x, y, s)],
});

/** The sheet's triangles in mercator (origin added back), as [ax, ay, bx, by, cx, cy]. */
function triangles(geoms: MaskGeom[]) {
  const { positions, origin } = cutTintSheet(geoms);
  assert.equal(positions.length % 6, 0);
  const out: number[][] = [];
  for (let i = 0; i < positions.length; i += 6) {
    const t: number[] = [];
    for (let k = 0; k < 6; k += 2)
      t.push(positions[i + k] + origin[0], positions[i + k + 1] + origin[1]);
    out.push(t);
  }
  return out;
}
const area = (ts: number[][]) =>
  ts.reduce(
    (a, [ax, ay, bx, by, cx, cy]) =>
      a + Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2,
    0,
  );
/** How many triangles hold the mercator point (x, y). */
function covering(ts: number[][], x: number, y: number) {
  const side = (ax: number, ay: number, bx: number, by: number) =>
    (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  return ts.filter(([ax, ay, bx, by, cx, cy]) => {
    const d1 = side(ax, ay, bx, by);
    const d2 = side(bx, by, cx, cy);
    const d3 = side(cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  }).length;
}
/** A square's area in mercator units. */
function mercArea(x: number, y: number, s: number) {
  const a = baseOf(x, y);
  const b = baseOf(x + s, y + s);
  return Math.abs((b.x - a.x) * (b.y - a.y));
}
const at = (lng: number, lat: number) => baseOf(lng, lat);

test("no selection, or one without a ring: no triangle, no grey", () => {
  for (const geoms of [
    [],
    [{ type: "Polygon", coordinates: [] }],
    [{ type: "MultiPolygon", coordinates: [[[]]] }],
    [{ type: "Point", coordinates: [4, 45] }],
  ] as MaskGeom[][]) {
    const { positions, origin } = cutTintSheet(geoms);
    assert.equal(positions.length, 0);
    assert.deepEqual(origin, [0, 0]);
  }
});

test("a square: the three world copies greyed, the square left clear", () => {
  const ts = triangles([square(4, 45, 1)]);
  assert.ok(Math.abs(area(ts) - (3 - mercArea(4, 45, 1))) < 1e-6, String(area(ts)));
  const inside = at(4.5, 45.5);
  assert.equal(covering(ts, inside.x, inside.y), 0);
  for (const [lng, lat] of [
    [3.5, 45.5],
    [5.5, 45.5],
    [4.5, 44.5],
    [4.5, 46.5],
    [-120, -30],
    [170, 70],
  ]) {
    const p = at(lng, lat);
    assert.equal(covering(ts, p.x, p.y), 1, `${lng}, ${lat}`);
    // The copy of the world to each side is greyed too.
    assert.equal(covering(ts, p.x - 1, p.y), 1, `${lng} - 360, ${lat}`);
    assert.equal(covering(ts, p.x + 1, p.y), 1, `${lng} + 360, ${lat}`);
  }
});

test("the sheet is relative to the selection's first vertex", () => {
  const { positions, origin } = cutTintSheet([square(4, 45, 1)]);
  const first = at(4, 45);
  assert.deepEqual(origin, [first.x, first.y]);
  // Float32 offsets stay small near the selection: one of them is the vertex itself.
  let hit = false;
  for (let i = 0; i < positions.length; i += 2) {
    if (positions[i] === 0 && positions[i + 1] === 0) hit = true;
  }
  assert.ok(hit);
});

test("an enclave (an inner ring) is greyed back in, inside its hole", () => {
  const withEnclave: MaskGeom = {
    type: "Polygon",
    coordinates: [ring(4, 45, 1), ring(4.4, 45.4, 0.2)],
  };
  const ts = triangles([withEnclave]);
  const enclave = at(4.5, 45.5);
  assert.equal(covering(ts, enclave.x, enclave.y), 1);
  const clear = at(4.1, 45.1);
  assert.equal(covering(ts, clear.x, clear.y), 0);
  const want = 3 - mercArea(4, 45, 1) + mercArea(4.4, 45.4, 0.2);
  assert.ok(Math.abs(area(ts) - want) < 1e-6);
});

test("several polygons, of one geometry or of several: every outer ring a hole", () => {
  const multi: MaskGeom = {
    type: "MultiPolygon",
    coordinates: [[ring(4, 45, 1)], [ring(8, 41, 0.5)]],
  };
  for (const geoms of [[multi], [square(4, 45, 1), square(8, 41, 0.5)]]) {
    const ts = triangles(geoms);
    for (const [lng, lat] of [
      [4.5, 45.5],
      [8.25, 41.25],
    ]) {
      const p = at(lng, lat);
      assert.equal(covering(ts, p.x, p.y), 0, `${lng}, ${lat}`);
    }
    const between = at(6, 43);
    assert.equal(covering(ts, between.x, between.y), 1);
    assert.ok(Math.abs(area(ts) - (3 - mercArea(4, 45, 1) - mercArea(8, 41, 0.5))) < 1e-6);
  }
  // The same bytes whichever way the polygons are grouped.
  const a = cutTintSheet([multi]);
  const b = cutTintSheet([square(4, 45, 1), square(8, 41, 0.5)]);
  assert.deepEqual(Buffer.from(a.positions.buffer), Buffer.from(b.positions.buffer));
});

test("a selection reaching past the pole's edge stays inside the world's frame", () => {
  // Mercator y of latitude 89.9 is below 0 (off the world): pinned to its edge.
  const ts = triangles([square(10, 80, 9.9)]);
  for (const t of ts) for (let k = 1; k < 6; k += 2) assert.ok(t[k] >= -1e-6 && t[k] <= 1 + 1e-6);
  const inside = at(15, 83);
  assert.equal(covering(ts, inside.x, inside.y), 0);
  const south = at(15, 60);
  assert.equal(covering(ts, south.x, south.y), 1);
});

test("the same geometry cut twice gives the same bytes (the projection cache changes nothing)", () => {
  const g = square(2, 48, 0.7);
  const a = cutTintSheet([g]);
  const b = cutTintSheet([g]);
  const fresh = cutTintSheet([square(2, 48, 0.7)]);
  assert.deepEqual(Buffer.from(a.positions.buffer), Buffer.from(b.positions.buffer));
  assert.deepEqual(Buffer.from(a.positions.buffer), Buffer.from(fresh.positions.buffer));
  assert.deepEqual(a.origin, fresh.origin);
});
