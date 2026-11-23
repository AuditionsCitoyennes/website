// The poster's path data read as rings (francePosterRings.ts). Run with
// `node --import tsx --test` (root "test:scripts"). Pure.

import assert from "node:assert/strict";
import { test } from "node:test";
import { posterRings } from "./francePosterRings";
import { POSTER_REGIONS } from "./francePoster";

test("moves and relative lines, one ring per move", () => {
  assert.deepEqual(posterRings("M1 2l3 4l-1-2zM10 10l1 0l0 1z"), [
    [
      [1, 2],
      [4, 6],
      [3, 4],
    ],
    [
      [10, 10],
      [11, 10],
      [11, 11],
    ],
  ]);
  assert.deepEqual(posterRings("M0 0L5 5l1 1"), [
    [
      [0, 0],
      [5, 5],
      [6, 6],
    ],
  ]);
  assert.throws(() => posterRings("M0 0C1 1 2 2 3 3"));
});

test("every région of the poster reads, inside its viewBox", () => {
  for (const r of POSTER_REGIONS) {
    const rings = posterRings(r.d);
    assert.ok(rings.length >= 1, r.id);
    for (const ring of rings) {
      assert.ok(ring.length >= 3, r.id);
      for (const [x, y] of ring) assert.ok(x >= 0 && x <= 600 && y >= 0 && y <= 579, r.id);
    }
  }
});
