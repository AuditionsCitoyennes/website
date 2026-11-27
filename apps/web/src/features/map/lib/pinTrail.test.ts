// Where the lieux' dots went while the camera flew (pinTrail.ts): the trail
// kept frame by frame, and the dot whose path passed under a press made
// during the flight — between two frames, along the straight line from one
// point to the next; only in the window before the press, never after it;
// only where the dot went slowly enough to be aimed at; of several, the
// nearest, then the latest. Plain samples stand in for useMapPins' projected
// markers. Run with `node --import tsx --test` (root "test:scripts"). Pure:
// no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pinOnTrail,
  pushTrail,
  TRAIL_AIM_SPEED,
  TRAIL_SLOP_PX,
  TRAIL_WINDOW_MS,
  type TrailSample,
} from "./pinTrail";

const o = { windowMs: TRAIL_WINDOW_MS, hitPx: 8 + TRAIL_SLOP_PX, aimSpeed: TRAIL_AIM_SPEED };

/** The dots `pins` ({id: [x, y]}) drawn at `t`. */
function at(t: number, pins: Record<string, [number, number]>): TrailSample {
  return { t, pins: Object.entries(pins).map(([id, [x, y]]) => ({ id, x, y })) };
}

test("pushTrail: keeps the samples of the last keepMs, the newest always", () => {
  const trail: TrailSample[] = [];
  pushTrail(trail, at(0, {}), 100);
  pushTrail(trail, at(50, {}), 100);
  pushTrail(trail, at(100, {}), 100);
  assert.deepEqual(
    trail.map((s) => s.t),
    [0, 50, 100],
  );
  pushTrail(trail, at(160, {}), 100);
  assert.deepEqual(
    trail.map((s) => s.t),
    [100, 160],
  );
  pushTrail(trail, at(5000, {}), 100);
  assert.deepEqual(
    trail.map((s) => s.t),
    [5000],
  );
});

test("pinOnTrail: a press on the path between two frames finds the dot", () => {
  // The dot went up from (241, 333) to (243, 285); the finger lands where it
  // was aimed, 48 px behind it.
  const trail = [at(0, { b: [241, 333] }), at(100, { b: [243, 285] })];
  assert.equal(pinOnTrail(trail, { x: 241, y: 333, t: 250 }, o), "b");
  // Half-way along it.
  assert.equal(pinOnTrail(trail, { x: 250, y: 309, t: 250 }, o), "b");
});

test("pinOnTrail: a dot there longer ago than the window is not found", () => {
  const trail = [at(0, { b: [100, 100] }), at(400, { b: [400, 100] }), at(900, { b: [400, 100] })];
  // (100, 100) was on the path before 400 ms: 500 ms before the press.
  assert.equal(pinOnTrail(trail, { x: 100, y: 100, t: 900 }, o), null);
  assert.equal(pinOnTrail(trail, { x: 400, y: 100, t: 900 }, o), "b");
});

test("pinOnTrail: a dot swept past too fast to aim at is not found", () => {
  // The flight's fast stretch: up 179 px in 68 ms (2.6 px/ms), the finger
  // landing 13 px beside that stretch, 43 px from the dot as drawn.
  const trail = [at(0, { c: [241, 333] }), at(160, { c: [242, 298] }), at(228, { c: [244, 119] })];
  assert.equal(pinOnTrail(trail, { x: 230, y: 160, t: 234 }, o), null);
  // Where it went slowly, before (0.22 px/ms), it was aimed at.
  assert.equal(pinOnTrail(trail, { x: 241, y: 320, t: 234 }, o), "c");
  // Just under the speed, just over it.
  const slow = [at(0, { c: [0, 100] }), at(100, { c: [100 * TRAIL_AIM_SPEED, 100] })];
  assert.equal(pinOnTrail(slow, { x: 50, y: 100, t: 120 }, o), "c");
  const fast = [at(0, { c: [0, 100] }), at(100, { c: [100 * TRAIL_AIM_SPEED + 2, 100] })];
  assert.equal(pinOnTrail(fast, { x: 50, y: 100, t: 120 }, o), null);
});

test("pinOnTrail: the frames drawn after the press are not read", () => {
  // A mouse's press leaves the flight going: the dot passes under the still
  // cursor after it.
  const trail = [at(0, { m: [100, 100] }), at(50, { m: [120, 100] }), at(100, { m: [140, 100] })];
  assert.equal(pinOnTrail(trail, { x: 140, y: 100, t: 40 }, o), null);
  assert.equal(pinOnTrail(trail, { x: 140, y: 100, t: 100 }, o), "m");
});

test("pinOnTrail: a press away from every path is the map's", () => {
  const trail = [at(0, { b: [100, 100] }), at(16, { b: [110, 100] })];
  assert.equal(pinOnTrail(trail, { x: 105, y: 140, t: 50 }, o), null);
  assert.equal(pinOnTrail(trail, { x: 105, y: 100 + o.hitPx + 1, t: 50 }, o), null);
  assert.equal(pinOnTrail(trail, { x: 105, y: 100 + o.hitPx, t: 50 }, o), "b");
  assert.equal(pinOnTrail([], { x: 105, y: 100, t: 50 }, o), null);
});

test("pinOnTrail: of two dots whose paths passed there, the nearest", () => {
  // Flying up, Sathonay follows the Croix-Rousse: it passes 16 px beside the
  // point the Croix-Rousse was aimed at, after it.
  const trail = [
    at(51, { croix: [241, 342], sathonay: [231, 390] }),
    at(67, { croix: [241, 334], sathonay: [231, 384] }),
    at(83, { croix: [241, 321], sathonay: [231, 373] }),
    at(99, { croix: [242, 303], sathonay: [230, 358] }),
    at(124, { croix: [242, 284], sathonay: [229, 345] }),
  ];
  assert.equal(pinOnTrail(trail, { x: 241, y: 334, t: 125 }, o), "croix");
  // Under the one behind, it is that one.
  assert.equal(pinOnTrail(trail, { x: 230, y: 360, t: 125 }, o), "sathonay");
});

test("pinOnTrail: at the same distance, the one there latest", () => {
  // `a` crossed (200, 200) first, `b` after it (0.5 px/ms each).
  const trail = [
    at(0, { a: [200, 220], b: [200, 280] }),
    at(40, { a: [200, 200], b: [200, 260] }),
    at(80, { a: [200, 180], b: [200, 240] }),
    at(120, { a: [200, 160], b: [200, 220] }),
    at(160, { a: [200, 140], b: [200, 200] }),
    at(200, { a: [200, 120], b: [200, 180] }),
  ];
  assert.equal(pinOnTrail(trail, { x: 200, y: 200, t: 210 }, o), "b");
  // At the same frame, the nearest.
  const same = [at(0, { a: [190, 200], b: [215, 200] })];
  assert.equal(pinOnTrail(same, { x: 200, y: 200, t: 10 }, o), "a");
});

test("pinOnTrail: a dot drawn on one frame only is its point", () => {
  // `c` came into the plot on the last frame; `d` left it after the first.
  const trail = [at(0, { d: [50, 50] }), at(16, { c: [300, 300] })];
  assert.equal(pinOnTrail(trail, { x: 302, y: 298, t: 30 }, o), "c");
  assert.equal(pinOnTrail(trail, { x: 52, y: 50, t: 30 }, o), "d");
  // Not along a line to another dot's point.
  assert.equal(pinOnTrail(trail, { x: 175, y: 175, t: 30 }, o), null);
});
