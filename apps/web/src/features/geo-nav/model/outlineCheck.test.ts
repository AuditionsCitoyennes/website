// The lift check (outlineCheck.ts) on toy scopes. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { liftCheck } from "./outlineCheck";

/** Degrees of longitude for `m` metres at latitude 45. */
const lngM = (m: number) => m / (111_195 * Math.cos((45 * Math.PI) / 180));
const latM = (m: number) => m / 111_195;
const poly = (...ring: number[][]) => ({ type: "Polygon", coordinates: [[...ring, ring[0]]] });

// A scope 0.2° wide at latitude 45, cut in two by x = 5.1: the bottom and top
// edges carry the cut's ends as vertices, as a file's self and entries do.
const SCOPE = poly([5, 45], [5.1, 45], [5.2, 45], [5.2, 45.1], [5.1, 45.1], [5, 45.1]);
const WEST = poly([5, 45], [5.1, 45], [5.1, 45.1], [5, 45.1]);
const EAST = poly([5.1, 45], [5.2, 45], [5.2, 45.1], [5.1, 45.1]);

test("children cut by the same run: every boundary vertex shared", () => {
  const r = liftCheck(SCOPE, [WEST, EAST]);
  assert.equal(r.offLid, 0);
  assert.equal(r.nearMiss, 0);
  assert.equal(r.liftedShare, 1);
  assert.equal(r.lifted, 2);
  // The scope's whole edge: 0.4° of longitude at latitude 45 (four 0.1° edges) and 0.2° of
  // latitude (the west and east sides); the cut, inside, is not on it.
  const m = 4 * 0.1 * 111_195 * Math.cos((45 * Math.PI) / 180) + 2 * 0.1 * 111_195;
  assert.ok(Math.abs(r.boundaryM - m) < 50, `${r.boundaryM} vs ${m}`);
});

test("a cut end 2 m along the edge: off the lid's vertices, share below 1", () => {
  const x = 5.1 + lngM(2);
  const west = poly([5, 45], [x, 45], [5.1, 45.1], [5, 45.1]);
  const r = liftCheck(SCOPE, [west, EAST]);
  assert.equal(r.offLid, 1);
  assert.equal(r.nearMiss, 0); // 2 m from the nearest scope vertex
  assert.ok(r.liftedShare !== null && r.liftedShare < 1);
});

test("a vertex 0.7 m off a scope vertex, another key at 5 dp, is a near miss", () => {
  const west = poly([5, 45], [5.1 + lngM(0.7), 45], [5.1, 45.1], [5, 45.1]);
  const r = liftCheck(SCOPE, [west]);
  assert.equal(r.offLid, 1);
  assert.equal(r.nearMiss, 1);
  assert.ok(r.liftedShare !== null && r.liftedShare < 1);
});

test("the same edge offset by 2 m, outward or inward: off the lid, share below 1", () => {
  for (const dy of [-latM(2), latM(2)]) {
    const west = poly([5, 45 + dy], [5.1, 45 + dy], [5.1, 45.1], [5, 45.1]);
    const east = poly([5.1, 45 + dy], [5.2, 45 + dy], [5.2, 45.1], [5.1, 45.1]);
    const r = liftCheck(SCOPE, [west, east]);
    // Each ring's two moved vertices, 2 m beside the edge (the cut's end is in both).
    assert.equal(r.offLid, 4, `dy ${dy}`);
    assert.equal(r.nearMiss, 0);
    assert.ok(r.liftedShare !== null && r.liftedShare < 1, `dy ${dy}: ${r.liftedShare}`);
  }
});

test("an edge bulging 300 m off between two lid vertices: off the lid, share below 1", () => {
  const west = poly([5, 45], [5.05, 45 - latM(300)], [5.1, 45], [5.1, 45.1], [5, 45.1]);
  const r = liftCheck(SCOPE, [west, EAST]);
  assert.equal(r.offLid, 1); // the bulge's vertex
  // The bulge's two segments, ~3.9 km each, run along the edge off it.
  assert.ok(r.liftedShare !== null && r.liftedShare < 0.9, `${r.liftedShare}`);
});

test("an edge 500 m outside: the sides run on past the lid's corners", () => {
  const out = latM(500);
  const west = poly([5, 45 - out], [5.1, 45 - out], [5.1, 45.1], [5, 45.1]);
  const r = liftCheck(SCOPE, [west]);
  assert.equal(r.offLid, 1); // the west side's end; the cut's end leaves (5.1, 45.1) steeply
  assert.ok(r.liftedShare !== null && r.liftedShare < 1, `${r.liftedShare}`);
});

test("a cut leaving a lid vertex at 30° to the edge is not along it", () => {
  // West's cut leaves the bottom edge at (5.1, 45) at 30° and meets the top at (5.1, 45.1).
  const up = 0.1 * 111_195;
  const x = 5.1 + lngM(up / 2 / Math.tan((30 * Math.PI) / 180));
  const scope = poly([5, 45], [5.1, 45], [5.3, 45], [5.3, 45.1], [5.1, 45.1], [5, 45.1]);
  const west = poly([5, 45], [5.1, 45], [x, 45 + latM(up / 2)], [5.1, 45.1], [5, 45.1]);
  const r = liftCheck(scope, [west]);
  assert.equal(r.offLid, 0);
  assert.equal(r.liftedShare, 1);
});

test("a focus line whose box misses the lid's is not lifted, so not checked", () => {
  const far = poly([7, 45], [7.1 + lngM(2), 45], [7.1, 45.1], [7, 45.1]);
  const r = liftCheck(SCOPE, [far]);
  assert.equal(r.lifted, 0);
  assert.equal(r.offLid, 0);
  assert.equal(r.liftedShare, null);
});

test("a MultiPolygon scope: each polygon's box lifts, holes count as boundary", () => {
  const hole = [
    [5.05, 45.04],
    [5.06, 45.04],
    [5.06, 45.05],
    [5.05, 45.04],
  ];
  const scope = {
    type: "MultiPolygon",
    coordinates: [
      [[...SCOPE.coordinates[0]], hole],
      [
        [
          [6, 45],
          [6.1, 45],
          [6.1, 45.1],
          [6, 45],
        ],
      ],
    ],
  };
  const islet = poly([6, 45], [6.1, 45], [6.1, 45.1]);
  const inHole = poly([5.05, 45.04], [5.06, 45.04], [5.06, 45.05]);
  const r = liftCheck(scope, [WEST, islet, inHole]);
  assert.equal(r.lifted, 3);
  assert.equal(r.offLid, 0);
  assert.equal(r.liftedShare, 1);
});
