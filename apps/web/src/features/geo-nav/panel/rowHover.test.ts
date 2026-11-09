// The unit rows' hover gate (rowHover.ts): a mouse, or an event naming no
// pointer, hovers a row on `mouseenter`; a touch or a pen does not. The
// sequence test drives the shipped rowHoverGate with a recorded emit list
// standing in for UnitList's two handlers. Run with `node --import tsx --test`
// (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mouseEnterHovers, rowHoverGate } from "./rowHover";

test("mouseEnterHovers: a mouse or no pointer type hovers, touch, pen and others do not", () => {
  assert.equal(mouseEnterHovers("mouse"), true);
  assert.equal(mouseEnterHovers(undefined), true);
  assert.equal(mouseEnterHovers(""), true);
  assert.equal(mouseEnterHovers("touch"), false);
  assert.equal(mouseEnterHovers("pen"), false);
  assert.equal(mouseEnterHovers("foo"), false);
});

test("rowHoverGate: the last entering pointer decides each row's mouseenter", () => {
  const gate = rowHoverGate();
  const emitted: string[] = [];
  // UnitList's handlers: onPointerEnter records the type, onMouseEnter emits.
  const pointerEnter = (type: string) => gate.pointerEnter(type);
  const mouseEnter = (id: string) => {
    if (gate.mouseEnterHovers()) emitted.push(id);
  };

  mouseEnter("synthetic"); // a script's MouseEvent, no pointer seen yet
  pointerEnter("mouse");
  mouseEnter("mouse-row");
  pointerEnter("touch");
  mouseEnter("tapped-row"); // the tap's compatibility mouseenter
  pointerEnter("mouse");
  mouseEnter("next-row"); // not reset per row: the last pointer's type
  pointerEnter("touch");
  mouseEnter("tapped-again");

  assert.deepEqual(emitted, ["synthetic", "mouse-row", "next-row"]);
});

test("rowHoverGate: two gates are independent (one per list instance)", () => {
  const a = rowHoverGate();
  const b = rowHoverGate();
  a.pointerEnter("touch");
  assert.equal(a.mouseEnterHovers(), false);
  assert.equal(b.mouseEnterHovers(), true);
  b.pointerEnter("mouse");
  assert.equal(a.mouseEnterHovers(), false);
  assert.equal(b.mouseEnterHovers(), true);
});
