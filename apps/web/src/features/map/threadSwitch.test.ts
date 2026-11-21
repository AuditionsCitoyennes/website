// Where the map's work runs by the device's tier (threadSwitch.ts), run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { globeFrameWaitsFor, tintCutFor } from "./threadSwitch";

test("a globe frame before its set: built on the page on the full tier, waited for elsewhere", () => {
  assert.equal(globeFrameWaitsFor("full"), false);
  assert.equal(globeFrameWaitsFor("light"), true);
  assert.equal(globeFrameWaitsFor("minimal"), true);
});

test("the grey sheet: cut on the page on the full tier, in the worker elsewhere", () => {
  assert.equal(tintCutFor("full"), "page");
  assert.equal(tintCutFor("light"), "worker");
  assert.equal(tintCutFor("minimal"), "worker");
});
