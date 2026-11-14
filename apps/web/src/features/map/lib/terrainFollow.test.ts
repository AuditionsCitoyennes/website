// The terrain-transition helpers (terrainFollow.ts) against map-like objects,
// run with `node --import tsx --test` (root "test:scripts"): what can be
// followed, the frame's exaggeration, the pump, the one setTerrain's spec and
// when a transition is over.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canFollowTerrain,
  frameExaggeration,
  pumpTransition,
  transitionSettled,
  transitionSpec,
  type FollowMap,
} from "./terrainFollow";

test("canFollowTerrain: both internals where 3.34 has them, else no", () => {
  assert.equal(canFollowTerrain({ painter: {}, _update: () => {} }), true);
  assert.equal(canFollowTerrain({ painter: { terrain: null }, _update: () => {} }), true);
  assert.equal(canFollowTerrain({ painter: {} }), false);
  assert.equal(canFollowTerrain({ _update: () => {} }), false);
  assert.equal(canFollowTerrain({ painter: null, _update: () => {} }), false);
  assert.equal(canFollowTerrain({ painter: {}, _update: true } as unknown as FollowMap), false);
  assert.equal(canFollowTerrain(null), false);
  assert.equal(canFollowTerrain(undefined), false);
});

test("frameExaggeration: the renderer's value, null where there is none to read", () => {
  const map = (terrain: unknown): FollowMap => ({ painter: { terrain } }) as FollowMap;
  assert.equal(frameExaggeration(map({ exaggeration: () => 0.42 })), 0.42);
  assert.equal(frameExaggeration(map({ exaggeration: () => 0 })), 0);
  assert.equal(frameExaggeration(map({ exaggeration: () => 1 })), 1);
  // No terrain running (the flat map, none set): mapbox's getter hands null.
  assert.equal(frameExaggeration(map(null)), null);
  assert.equal(frameExaggeration(map(undefined)), null);
  // Not where 3.34 has it, or not a height.
  assert.equal(frameExaggeration(map({})), null);
  assert.equal(frameExaggeration(map({ exaggeration: 1 })), null);
  assert.equal(frameExaggeration(map({ exaggeration: () => "1" })), null);
  assert.equal(frameExaggeration(map({ exaggeration: () => NaN })), null);
  assert.equal(frameExaggeration(map({ exaggeration: () => Infinity })), null);
  assert.equal(frameExaggeration({}), null);
  assert.equal(frameExaggeration({ painter: null }), null);
  assert.equal(frameExaggeration(null), null);
  // A getter that throws (a removed map) reads as nothing.
  const thrower = {
    get painter(): never {
      throw new Error("removed");
    },
  } as unknown as FollowMap;
  assert.equal(frameExaggeration(thrower), null);
  assert.equal(
    frameExaggeration(
      map({
        exaggeration: () => {
          throw new Error("lost");
        },
      }),
    ),
    null,
  );
});

test("pumpTransition: one style-dirty frame asked for, per call", () => {
  const calls: unknown[] = [];
  const map: FollowMap = { _update: (updateStyle) => calls.push(updateStyle) };
  assert.equal(pumpTransition(map), true);
  assert.equal(pumpTransition(map), true);
  assert.deepEqual(calls, [true, true]);
  assert.equal(pumpTransition({}), false);
  assert.equal(pumpTransition(null), false);
  assert.equal(
    pumpTransition({
      _update: () => {
        throw new Error("removed");
      },
    }),
    false,
  );
});

test("transitionSpec: the source, the target and the move's time, never a snap", () => {
  assert.deepEqual(transitionSpec("plateau-dem-a", 1, 300), {
    source: "plateau-dem-a",
    exaggeration: 1,
    "exaggeration-transition": { duration: 300, delay: 0 },
  });
  assert.deepEqual(transitionSpec("plateau-dem-b", 0, 59.2), {
    source: "plateau-dem-b",
    exaggeration: 0,
    "exaggeration-transition": { duration: 60, delay: 0 },
  });
  // What is left of a transition taken up again can be next to nothing.
  assert.equal(transitionSpec("s", 1, 0)["exaggeration-transition"].duration, 1);
  assert.equal(transitionSpec("s", 1, -12)["exaggeration-transition"].duration, 1);
});

test("transitionSettled: the time passed and a frame drawn at the target, both", () => {
  // In flight.
  assert.equal(transitionSettled(100, 300, 0.4, 1), false);
  // At the target early (a chained transition that started there): the time first.
  assert.equal(transitionSettled(100, 300, 1, 1), false);
  // Time passed, the last frame drawn was before the end: one more frame.
  assert.equal(transitionSettled(301, 300, 0.997, 1), false);
  assert.equal(transitionSettled(300, 300, 1, 1), true);
  assert.equal(transitionSettled(420, 300, 1, 1), true);
  // A sink.
  assert.equal(transitionSettled(151, 150, 0.01, 0), false);
  assert.equal(transitionSettled(151, 150, 0, 0), true);
});
