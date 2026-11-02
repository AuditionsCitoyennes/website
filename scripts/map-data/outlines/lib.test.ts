import assert from "node:assert/strict";
import { test } from "node:test";
import { enrich as apiEnrich } from "../../../apps/api/src/modules/boundaries/geometry";
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
  const geoms: Geometry[] = [
    poly(square(2.1, 48.7, 0.3)),
    poly(square(0, 0, 4), square(1, 1, 1).reverse()),
    { type: "MultiPolygon", coordinates: [[square(0, 0, 1)], [square(5, 5, 2)]] },
    poly(ring(3, 3, 4, 3, 5, 3, 3, 3)), // no area: the first point
    poly(ring(-61.81, 16.0, -61.0, 16.2, -61.2, 16.5, -61.75, 16.42, -61.81, 16.0)),
  ];
  for (const g of geoms) {
    const a = apiEnrich({ geometry: g, properties: {} }).properties;
    const b = lib.enrich(g);
    assert.equal(JSON.stringify(b.center), JSON.stringify(a.center));
    const bbox = [a.bounds.minLng, a.bounds.minLat, a.bounds.maxLng, a.bounds.maxLat];
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
