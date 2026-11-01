// The rise/sink progress clamp (rise.ts), run with `node --import tsx --test`
// (root "test:scripts"). Pure: no map, no Vue, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { riseProgress } from "./rise";

// animateTerrain's and animateSlabs' ease.
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

test("a frame stamped before t0 is at the start", () => {
  assert.equal(riseProgress(750, 1000, 300), 0);
  assert.equal(riseProgress(-1e9, 1000, 300), 0);
});

test("a frame past t0 + ms is at the end", () => {
  assert.equal(riseProgress(1301, 1000, 300), 1);
  assert.equal(riseProgress(1e9, 1000, 300), 1);
});

test("the endpoints are exact", () => {
  assert.equal(riseProgress(1000, 1000, 300), 0);
  assert.equal(riseProgress(1300, 1000, 300), 1);
  assert.equal(riseProgress(1150, 1000, 300), 0.5);
});

test("a rise from 0 never goes below 0, a sink from 1 never above 1", () => {
  const t0 = 1000;
  // The spike's −5.11: a frame stamped ~250 ms before t0 on a 300 ms rise.
  for (let now = t0 - 400; now <= t0 + 400; now += 7) {
    for (const ms of [150, 300]) {
      const e = ease(riseProgress(now, t0, ms));
      const rise = 0 + (1 - 0) * e;
      const sink = 1 + (0 - 1) * e;
      assert.ok(rise >= 0 && rise <= 1, `rise ${rise} at ${now - t0} ms`);
      assert.ok(sink >= 0 && sink <= 1, `sink ${sink} at ${now - t0} ms`);
    }
  }
});
