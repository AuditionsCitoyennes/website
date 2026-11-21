// A phone's raised sheet as tall as its content (sheetFit.ts): the offset
// from the full box, the minimum, the snap to full, the hold while loading,
// how a refit moves and where a released drag settles. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue component,
// no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLLOW_MS,
  FOLLOW_PX,
  SNAP_FULL_PX,
  raisedOffset,
  refitMotion,
  sheetSettle,
} from "./sheetFit";

const base = { mode: "ajuste" as const, fullPx: 675, minPx: 200, heldOffset: null };

test("« Plein » is always the full sheet", () => {
  assert.equal(raisedOffset({ ...base, mode: "plein", contentPx: 120 }), 0);
  assert.equal(raisedOffset({ ...base, mode: "plein", contentPx: 2000 }), 0);
});

test("short content slides the sheet down to its height, long content keeps it full", () => {
  assert.equal(raisedOffset({ ...base, contentPx: 300 }), 375);
  assert.equal(raisedOffset({ ...base, contentPx: 300.4 }), 375);
  assert.equal(raisedOffset({ ...base, contentPx: 675 }), 0);
  assert.equal(raisedOffset({ ...base, contentPx: 2000 }), 0);
  // Nothing measured yet: the full sheet.
  assert.equal(raisedOffset({ ...base, fullPx: 0, contentPx: 300 }), 0);
});

test("a sliver of map left above the sheet goes full", () => {
  assert.equal(raisedOffset({ ...base, contentPx: 675 - SNAP_FULL_PX + 1 }), 0);
  assert.equal(raisedOffset({ ...base, contentPx: 675 - SNAP_FULL_PX }), SNAP_FULL_PX);
});

test("the sheet never stands lower than its minimum, nor above the full box", () => {
  assert.equal(raisedOffset({ ...base, contentPx: 90 }), 675 - 200);
  // A minimum above the box (a small landscape phone): full.
  assert.equal(raisedOffset({ ...base, minPx: 900, contentPx: 90 }), 0);
});

test("while loading the sheet may grow, not shrink", () => {
  // Held at 375 (300 px tall): taller content grows it…
  assert.equal(raisedOffset({ ...base, contentPx: 500, heldOffset: 375 }), 175);
  // …shorter content leaves it as it is.
  assert.equal(raisedOffset({ ...base, contentPx: 210, heldOffset: 375 }), 375);
  // Held full: stays full.
  assert.equal(raisedOffset({ ...base, contentPx: 210, heldOffset: 0 }), 0);
});

test("a refit snaps on a weak device, on a box change and while following a tween", () => {
  const anim = { deltaPx: 200, sinceLastMs: 1000, fullChanged: false, short: false };
  assert.equal(refitMotion(anim), "animate");
  assert.equal(refitMotion({ ...anim, short: true }), "snap");
  assert.equal(refitMotion({ ...anim, fullChanged: true }), "snap");
  assert.equal(
    refitMotion({ ...anim, deltaPx: -(FOLLOW_PX - 1), sinceLastMs: FOLLOW_MS - 1 }),
    "snap",
  );
  // A small step long after the last one, or a big one right after it: eased.
  assert.equal(refitMotion({ ...anim, deltaPx: FOLLOW_PX - 1, sinceLastMs: FOLLOW_MS }), "animate");
  assert.equal(refitMotion({ ...anim, deltaPx: FOLLOW_PX, sinceLastMs: 10 }), "animate");
});

test("a released drag settles on the nearer rest unless flicked", () => {
  const flick = 0.35;
  // A full raised sheet (today's numbers): the midpoint is half the lowered offset.
  assert.equal(sheetSettle({ at: 300, v: 0, raisedPx: 0, loweredPx: 610, flick }), true);
  assert.equal(sheetSettle({ at: 306, v: 0, raisedPx: 0, loweredPx: 610, flick }), false);
  // A fitted one: the midpoint of its own range.
  assert.equal(sheetSettle({ at: 490, v: 0, raisedPx: 375, loweredPx: 610, flick }), true);
  assert.equal(sheetSettle({ at: 495, v: 0, raisedPx: 375, loweredPx: 610, flick }), false);
  // A flick follows its direction wherever it is let go.
  assert.equal(sheetSettle({ at: 600, v: -0.5, raisedPx: 375, loweredPx: 610, flick }), true);
  assert.equal(sheetSettle({ at: 380, v: 0.5, raisedPx: 375, loweredPx: 610, flick }), false);
  assert.equal(sheetSettle({ at: 380, v: 0.3, raisedPx: 375, loweredPx: 610, flick }), true);
});
