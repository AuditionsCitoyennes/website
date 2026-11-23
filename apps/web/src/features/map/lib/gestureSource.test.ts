// Who started a gesture that moves the map (gestureSource.ts). Run with
// `node --import tsx --test` (root "test:scripts"). Pure: fake targets, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { gestureSourceOf } from "./gestureSource";

/** A target whose ancestors carry these classes (itself first). */
function el(...classes: string[]) {
  return {
    closest: (sel: string) => (classes.includes(sel.replace(/^\./, "")) ? {} : null),
  };
}

test("the keys on a focused map", () => {
  assert.equal(gestureSourceOf({ type: "keydown", target: el("mapboxgl-canvas") }), "keys");
  assert.equal(gestureSourceOf({ type: "keyup" }), "keys");
});

test("the map's zoom buttons", () => {
  assert.equal(
    gestureSourceOf({ type: "click", target: el("mapboxgl-ctrl-zoom-in", "mapboxgl-ctrl") }),
    "controls",
  );
});

test("a hand: a drag, a pinch, a double-tap, the wheel, the mouse", () => {
  for (const type of [
    "touchstart",
    "touchmove",
    "pointermove",
    "mousedown",
    "mousemove",
    "dblclick",
    "wheel",
  ])
    assert.equal(gestureSourceOf({ type, target: el("mapboxgl-canvas") }), "hand", type);
  // A click off the controls, and targets that cannot be asked.
  assert.equal(gestureSourceOf({ type: "click", target: el("mapboxgl-canvas") }), "hand");
  assert.equal(gestureSourceOf({ type: "touchmove" }), "hand");
  assert.equal(gestureSourceOf({ type: "touchmove", target: null }), "hand");
  assert.equal(gestureSourceOf({ type: "touchmove", target: {} }), "hand");
});
