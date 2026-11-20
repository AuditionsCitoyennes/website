// When the plateau's rise starts (riseSwitch.ts), run with `node --import tsx
// --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { LAND_WAIT_CAP_MS, riseStartFor } from "./riseSwitch";

test("riseStartFor: in flight on the full tier, after the flight on a weak device", () => {
  assert.equal(riseStartFor("full"), "flight");
  assert.equal(riseStartFor("light"), "after");
  assert.equal(riseStartFor("minimal"), "after");
  // Longer than the longest flight (an arc: 3 s), and never a long wait.
  assert.ok(LAND_WAIT_CAP_MS > 3000 && LAND_WAIT_CAP_MS <= 5000);
});
