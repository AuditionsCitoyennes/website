// The end of the camera flight in the air (flightEnd.ts). Clocks at a
// realistic page age. Run with `node --import tsx --test` (root
// "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlightEnd } from "./flightEnd";

test("a flight's end is its duration from the call; nothing before any flight", () => {
  let t = 60_000;
  const f = createFlightEnd(() => t);
  assert.equal(f.at(), 0);
  f.begin(1, 550);
  assert.equal(f.at(), 60_550);
  t += 300;
  assert.equal(f.at(), 60_550); // a clock time, not a countdown
});

test("cleared at its own moveend", () => {
  const f = createFlightEnd(() => 60_000);
  f.begin(1, 550);
  f.ended(1);
  assert.equal(f.at(), 0);
});

test("a newer flight replaces it, and the old one's moveend clears nothing", () => {
  let t = 60_000;
  const f = createFlightEnd(() => t);
  f.begin(1, 550);
  t += 200;
  f.begin(2, 900);
  assert.equal(f.at(), 61_100);
  f.ended(1); // the old flight's moveend, fired when the new one cut it
  assert.equal(f.at(), 61_100);
  f.ended(2);
  assert.equal(f.at(), 0);
});

test("a duration not known, an instant move: no end", () => {
  const f = createFlightEnd(() => 60_000);
  f.begin(1, undefined);
  assert.equal(f.at(), 0);
  f.begin(2, 0);
  assert.equal(f.at(), 0);
  f.begin(3, 550);
  f.none();
  assert.equal(f.at(), 0);
});
