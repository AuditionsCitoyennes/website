// The map canvas's hover gate (canvasHover.ts): a mouse, or a canvas that saw
// no pointer event, hovers a territory on `mousemove`; a touch or a pen does
// not. The sequence test drives the shipped canvasHoverGate with a recorded
// hover list standing in for useMapPins' pointer listener and onMapHover. Run
// with `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasHoverGate, mouseMoveHovers } from "./canvasHover";

test("mouseMoveHovers: a mouse or no pointer type hovers, touch, pen and others do not", () => {
  assert.equal(mouseMoveHovers("mouse"), true);
  assert.equal(mouseMoveHovers(undefined), true);
  assert.equal(mouseMoveHovers(""), true);
  assert.equal(mouseMoveHovers("touch"), false);
  assert.equal(mouseMoveHovers("pen"), false);
  assert.equal(mouseMoveHovers("foo"), false);
});

test("canvasHoverGate: the pointer last seen on the canvas decides each mousemove", () => {
  const gate = canvasHoverGate();
  const hovered: string[] = [];
  // useMapPins: the pointer listener records the type, the canvas mousemove hovers.
  const pointer = (type: string) => gate.pointerSeen(type);
  const mouseMove = (unit: string) => {
    if (gate.mouseMoveHovers()) hovered.push(unit);
  };

  mouseMove("synthetic"); // a script's MouseEvent, no pointer seen yet
  pointer("mouse");
  mouseMove("mouse-unit");
  pointer("touch"); // a tap's pointerdown…
  mouseMove("tapped-unit"); // …then its compatibility mousemove
  pointer("mouse"); // the mouse moves again (its pointermove comes first)
  mouseMove("next-unit");
  pointer("pen");
  mouseMove("pen-unit");

  assert.deepEqual(hovered, ["synthetic", "mouse-unit", "next-unit"]);
});

test("canvasHoverGate: two gates are independent (one per map instance)", () => {
  const a = canvasHoverGate();
  const b = canvasHoverGate();
  a.pointerSeen("touch");
  assert.equal(a.mouseMoveHovers(), false);
  assert.equal(b.mouseMoveHovers(), true);
  b.pointerSeen("mouse");
  assert.equal(a.mouseMoveHovers(), false);
  assert.equal(b.mouseMoveHovers(), true);
});
