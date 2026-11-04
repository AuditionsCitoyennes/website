// The touch gesture builders: pointers, coordinates, durations and clamping.
import assert from "node:assert/strict";
import { test } from "node:test";

import { touchPan, touchPinch, touchTap } from "./gestures";
import type { ActionSequence } from "./webdriver";

const VP = { width: 402, height: 714 };

type Move = { type: string; x?: number; y?: number; duration?: number; origin?: string };
const moves = (p: ActionSequence) => p.actions.filter((a) => a.type === "pointerMove") as Move[];
const start = (p: ActionSequence) => [moves(p)[0].x, moves(p)[0].y];
const end = (p: ActionSequence) => [moves(p).at(-1)?.x, moves(p).at(-1)?.y];
const duration = (p: ActionSequence) =>
  p.actions.reduce((a, x) => a + (typeof x.duration === "number" ? x.duration : 0), 0);

function assertTouch(seqs: ActionSequence[]) {
  for (const p of seqs) {
    assert.equal(p.type, "pointer");
    assert.deepEqual(p.parameters, { pointerType: "touch" });
    for (const m of moves(p)) {
      assert.equal(m.origin, "viewport");
      assert.ok(Number.isInteger(m.x) && Number.isInteger(m.y));
    }
    assert.equal(p.actions.at(-1)?.type, "pointerUp");
    assert.equal(p.actions.filter((a) => a.type === "pointerDown").length, 1);
  }
}

test("pan: one touch pointer from `from` to `from + delta`, integer, up last", () => {
  const { actions } = touchPan([201.4, 260.6], [80, 0], 400, VP);
  assert.equal(actions.length, 1);
  assertTouch(actions);
  assert.deepEqual(start(actions[0]), [201, 261]);
  assert.deepEqual(end(actions[0]), [281, 261]);
  assert.equal(duration(actions[0]), 400);
});

test("pinch: two pointers, distinct ids, symmetric about the centre, 2·r0 to 2·r1", () => {
  const { actions } = touchPinch([201, 260], 60, 75, 400, VP);
  assert.equal(actions.length, 2);
  assertTouch(actions);
  assert.notEqual(actions[0].id, actions[1].id);
  const [a0, b0] = [start(actions[0]), start(actions[1])] as number[][];
  const [a1, b1] = [end(actions[0]), end(actions[1])] as number[][];
  assert.equal((a0[0] + b0[0]) / 2, 201);
  assert.equal(a0[1], 260);
  assert.equal(b0[1], 260);
  assert.equal(b0[0] - a0[0], 120);
  assert.equal(b1[0] - a1[0], 150);
  assert.equal((a1[0] + b1[0]) / 2, 201);
  for (const p of actions) assert.equal(duration(p), 400);
});

test("tap: one touch pointer, down and up at the same point after a pause of `ms`", () => {
  const { actions } = touchTap([201.2, 654.7], 150, VP);
  assert.equal(actions.length, 1);
  assertTouch(actions);
  assert.deepEqual(start(actions[0]), [201, 655]);
  assert.equal(moves(actions[0]).length, 1);
  assert.deepEqual(
    actions[0].actions.map((a) => a.type),
    ["pointerMove", "pointerDown", "pause", "pointerUp"],
  );
  assert.equal(duration(actions[0]), 150);
  assert.deepEqual(start(touchTap([500, 900], 0, VP).actions[0]), [VP.width - 2, VP.height - 2]);
});

test("coordinates are clamped one pixel inside the viewport", () => {
  const pan = touchPan([5, 5], [-50, 800], 300, VP).actions[0];
  assert.deepEqual(start(pan), [5, 5]);
  assert.deepEqual(end(pan), [1, VP.height - 2]);
  const pinch = touchPinch([390, 700], 20, 60, 300, VP).actions;
  assert.deepEqual(end(pinch[1]), [VP.width - 2, 700]);
  assert.deepEqual(start(pinch[0]), [370, 700]);
  const corner = touchPan([-10, -10], [0, 0], 0, VP).actions[0];
  assert.deepEqual(start(corner), [1, 1]);
});
