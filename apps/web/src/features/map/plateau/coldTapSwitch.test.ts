// The cold tap's rules (coldTapSwitch.ts), run with `node --import tsx --test`
// (root "test:scripts"): how long a plateau waits for its fine outline, and
// which tapped units wait for their children's boundaries.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SELF_GRACE_MS,
  TAP_OUTLINE_WAIT_MS,
  outlineWaitFor,
  tapLinesWaitFor,
} from "./coldTapSwitch";

test("the wait: a tapped unit's own file with a coarse shape in memory, the full one otherwise", () => {
  assert.equal(outlineWaitFor(true, 1200), 1200);
  assert.equal(outlineWaitFor(true, 1200, true), TAP_OUTLINE_WAIT_MS);
  assert.equal(outlineWaitFor(false, 1200, true), 1200);
  assert.equal(outlineWaitFor(false, 1200), 1200);
  // Under the long wait's sentence (geo-nav's SLOW_WAIT_MS, 5 s), over the full wait.
  assert.ok(TAP_OUTLINE_WAIT_MS > 1200 && TAP_OUTLINE_WAIT_MS < 5000);
  assert.ok(SELF_GRACE_MS > 0 && SELF_GRACE_MS < 200);
});

test("which tapped units wait for their children's boundaries", () => {
  for (const level of ["country", "region", "dep", "city"]) {
    assert.equal(tapLinesWaitFor(level), true, level);
  }
  assert.equal(tapLinesWaitFor("world"), false);
  assert.equal(tapLinesWaitFor("place"), false);
});
