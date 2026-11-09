import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "./lib";
import type { Geometry, Position } from "./lib";

/** A ring from flat x, y pairs. */
const ring = (...xy: number[]): Position[] =>
  Array.from({ length: xy.length / 2 }, (_, i) => [xy[2 * i], xy[2 * i + 1]]);
const poly = (...rings: Position[][]): Geometry => ({ type: "Polygon", coordinates: rings });
const square = (x: number, y: number, s = 1) => ring(x, y, x + s, y, x + s, y + s, x, y + s, x, y);

test("keyOf maps an id to its file name and back, and refuses an id holding _", () => {
  for (const id of ["FR", "fr:reg:84", "fr:dep:2A", "fr:com:69123"])
    assert.equal(lib.idOfKey(lib.keyOf(id)), id);
  assert.equal(lib.keyOf("fr:dep:69"), "fr_dep_69");
  assert.throws(() => lib.keyOf("fr:com:a_b"), /contains "_"/);
});

test("clean5 rounds, drops repeated points, closes rings and drops what collapses", () => {
  // The second point is the first at 5 decimals; the hole collapses.
  const outer = ring(1.123456, 2.000001, 1.123459, 2.000002, 3, 2, 3, 4);
  const g = poly(outer, ring(1.5, 2.5, 1.500001, 2.5, 1.5, 2.5));
  assert.deepEqual(lib.clean5(g), poly(ring(1.12346, 2, 3, 2, 3, 4, 1.12346, 2)));
  assert.equal(lib.clean5(poly(ring(0, 0, 0.000001, 0, 0, 0.000001, 0, 0))), null);
  const south = lib.clean5(poly(ring(0, -89, 1, -89, 1, -80, 0, -89)));
  assert.equal(south?.coordinates[0][0][1], -85.0511);
});

test("enrich is the API's: same centre, bounds as the bbox", () => {
  // The API's enrich() of each geometry (apps/api's boundaries/geometry.ts,
  // deleted with /api/boundaries), frozen: [geometry, center, bbox].
  const cases: [Geometry, string, number[]][] = [
    [poly(square(2.1, 48.7, 0.3)), "[48.84999999999951,2.249999999999971]", [2.1, 48.7, 2.4, 49]],
    [poly(square(0, 0, 4), square(1, 1, 1).reverse()), "[2,2]", [0, 0, 4, 4]],
    [
      { type: "MultiPolygon", coordinates: [[square(0, 0, 1)], [square(5, 5, 2)]] },
      "[6,6]",
      [0, 0, 7, 7],
    ],
    [poly(ring(3, 3, 4, 3, 5, 3, 3, 3)), "[3,3]", [3, 3, 5, 3]], // no area: the first point
    [
      poly(ring(-61.81, 16.0, -61.0, 16.2, -61.2, 16.5, -61.75, 16.42, -61.81, 16.0)),
      "[16.26590992406296,-61.4477232259719]",
      [-61.81, 16, -61, 16.5],
    ],
  ];
  for (const [g, center, bbox] of cases) {
    const b = lib.enrich(g);
    assert.equal(JSON.stringify(b.center), center);
    assert.deepEqual(b.bbox, bbox);
    assert.equal(JSON.stringify(b.bbox), JSON.stringify(bbox));
  }
});

// Two unit squares side by side and the rectangle they tile, drawn through
// the shared edge's end points (dy moves the top one north).
const kids = [poly(square(0, 0)), poly(square(1, 0))];
const rect = (dy = 0) => poly(ring(0, 0, 1, 0, 2, 0, 2, 1, 1, 1 + dy, 0, 1, 0, 0));

test("unionBoundary is the rectangle's segment set", () => {
  const diff = (g: Geometry) => lib.setDiff(lib.segmentKeys(g), lib.unionBoundary(kids));
  assert.deepEqual(diff(rect()), { onlyA: 0, onlyB: 0 });
  assert.deepEqual(diff(rect(0.001)), { onlyA: 2, onlyB: 2 });
});

test("coincidence: a shared edge is 0 m / 100 %, a moved vertex is not", () => {
  const exact = { childToSelfM: 0, selfToChildM: 0, sharedPct: 100 };
  assert.deepEqual(lib.coincidence(rect(), kids), exact);
  const moved = lib.coincidence(rect(0.001), kids); // ~110 m north
  assert.ok(moved.selfToChildM > 100 && moved.selfToChildM < 120, String(moved.selfToChildM));
  assert.ok(moved.childToSelfM > 0 && moved.sharedPct < 100);
});

test("rewind orients exteriors counter-clockwise and holes clockwise", () => {
  const g = lib.rewind(poly(square(0, 0, 4).reverse(), square(1, 1, 1)));
  assert.ok(lib.ringArea(g.coordinates[0] as Position[]) > 0);
  assert.ok(lib.ringArea(g.coordinates[1] as Position[]) < 0);
});

test("validateFileV1 accepts the three kinds and names what is wrong", () => {
  const g = poly(square(4, 45));
  const self = { id: "fr:dep:69", bbox: [4, 45, 5, 46], center: [45.5, 4.5], n: 5, g };
  const head = { v: 1, build: "o20261102-1", id: "fr:dep:69", tier: "e50", tolM: 0, self };
  const entry = { ...self, id: "fr:com:69123", name: "Lyon", level: "city", k: 1, u: 0 };
  const ok = (f: unknown) => assert.ok(lib.validateFileV1(f).ok, JSON.stringify(f));
  ok({ ...head, kind: "k", units: [entry] });
  ok({ ...head, kind: "u" });
  ok({ ...head, id: "ES", self: { ...self, id: "ES" }, kind: "g", tier: "w3000", tolM: 3000 });
  const bad = (f: unknown, reason: string) =>
    assert.deepEqual(lib.validateFileV1(f), { ok: false, reason });
  const noTier: Record<string, unknown> = { ...head, kind: "u" };
  delete noTier.tier;
  bad(noTier, "missing key tier");
  bad({ ...head, kind: "u", v: 2 }, "v is 2, not 1");
  bad({ ...head, kind: "x" }, 'kind "x"');
  bad({ ...head, kind: "k" }, "missing key units");
});

test("pickTier: the largest rung under diag / 4000, 15 m at least, raised by the vertex budget", () => {
  const fits = () => 100;
  const monaco = lib.diagM([7.40903, 43.72475, 7.43968, 43.75197]); // about 3.8 km
  assert.ok(monaco > 3_500 && monaco < 4_500, String(monaco));
  assert.equal(lib.pickTier(monaco, fits), 15);
  assert.equal(lib.pickTier(1_000_000, fits), 100); // 250 m by the diagonal
  const russia = lib.diagM([19.6387, 41.1851, 190.99232, 81.85905]); // unwrapped, about 10,150 km
  assert.equal(lib.pickTier(russia, fits), 1000);
  assert.equal(lib.pickTier(lib.diagM([-180, -85.0511, 180, -60.5]), fits), 3000); // Antarctica
  const heavy = (m: number) => (m < 3000 ? 25_000 : 7_000);
  assert.equal(lib.pickTier(russia, heavy), 3000);
  assert.equal(
    lib.pickTier(monaco, () => 20_001),
    null,
  );
});

test("unwrap moves polygons across ±180 next to the largest one, re-rounded", () => {
  const big = square(177, -18, 2); // 177..179: the largest, the anchor
  const east = square(-179.12345, -17, 0.5);
  const fiji: Geometry = { type: "MultiPolygon", coordinates: [[big], [east]] };
  const { g, wrap } = lib.unwrap(fiji);
  assert.ok(wrap);
  const moved = ring(
    180.87655,
    -17,
    181.37655,
    -17,
    181.37655,
    -16.5,
    180.87655,
    -16.5,
    180.87655,
    -17,
  );
  assert.deepEqual(g.coordinates[1], [moved]);
  assert.deepEqual(lib.bboxOf(g), [177, -18, 181.37655, -16]);
  // Toward the anchor's side, whichever it is: an Aleutian-like island west of -180.
  const us = lib.unwrap({
    type: "MultiPolygon",
    coordinates: [[square(-100, 35, 10)], [square(175, 52, 1)]],
  });
  assert.deepEqual(lib.bboxOf(us.g), [-185, 35, -90, 53]);
  const spain: Geometry = {
    type: "MultiPolygon",
    coordinates: [[square(-4, 40, 2)], [square(-18, 28, 1)]],
  };
  assert.deepEqual(lib.unwrap(spain), { g: spain, wrap: false });
  // Antarctica: its largest polygon spans -180..180 already; kept as delivered, flagged.
  const aq = ring(-180, -85.0511, 180, -85.0511, 180, -70, -180, -70, -180, -85.0511);
  const antarctica: Geometry = { type: "MultiPolygon", coordinates: [[aq], [square(170, -68)]] };
  assert.deepEqual(lib.unwrap(antarctica), { g: antarctica, wrap: true });
});
