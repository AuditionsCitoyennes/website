// The answer to a tap, its switches' pure part (tapAnswerSwitch.ts): what the
// pending mark is made of under each mode and pointer, and which taps count
// as a touch. Run with `node --import tsx --test` (root "test:scripts"). The
// module is loaded as a build without the testing tools: storage unread.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const tap = await import("./tapAnswerSwitch");

test("auto: the stroke everywhere, the fill on a touch screen only", () => {
  assert.deepEqual(tap.tapMarkFor("auto", false), { stroke: true, fill: false, pill: true });
  assert.deepEqual(tap.tapMarkFor("auto", true), { stroke: true, fill: true, pill: true });
});

test("stroke and fill: the same on every device", () => {
  for (const touch of [false, true]) {
    assert.deepEqual(tap.tapMarkFor("stroke", touch), { stroke: true, fill: false, pill: true });
    assert.deepEqual(tap.tapMarkFor("fill", touch), { stroke: false, fill: true, pill: true });
  }
});

test("off: no mark at all, as before", () => {
  for (const touch of [false, true]) {
    assert.deepEqual(tap.tapMarkFor("off", touch), { stroke: false, fill: false, pill: false });
  }
});

test("a touch or a pen is a touch, a mouse is not, whatever the device", () => {
  assert.equal(tap.tapIsTouch("touch", true), true);
  assert.equal(tap.tapIsTouch("pen", true), true);
  assert.equal(tap.tapIsTouch("mouse", false), false);
});

test("no pointer seen yet (a key): the device's main pointer decides", () => {
  assert.equal(tap.tapIsTouch(undefined, true), false);
  assert.equal(tap.tapIsTouch(undefined, false), true);
  assert.equal(tap.tapIsTouch("", false), true);
});

test("a build without the testing tools keeps the defaults and ignores the setters", () => {
  assert.equal(tap.DEFAULT_TAP_ANSWER, "auto");
  assert.equal(tap.DEFAULT_TAP_FRAME, "same");
  assert.equal(tap.tapAnswerMode.value, "auto");
  assert.equal(tap.tapFrameMode.value, "same");
  tap.setTapAnswerMode("off");
  tap.setTapFrameMode("own");
  assert.equal(tap.tapAnswerMode.value, "auto");
  assert.equal(tap.tapFrameMode.value, "same");
  assert.deepEqual([...tap.TAP_ANSWER_MODES], ["auto", "stroke", "fill", "off"]);
  assert.deepEqual([...tap.TAP_FRAME_MODES], ["same", "own"]);
});
