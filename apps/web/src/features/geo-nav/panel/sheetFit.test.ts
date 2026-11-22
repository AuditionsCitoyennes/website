// A phone's raised sheet as tall as its content (sheetFit.ts): the offset
// from the full box, the minimum, the snaps to full (a sliver of map, no
// room for the map's controls), the hold while loading, the camera's aim
// under « Ajusté, centré », how a refit moves and where a released drag settles. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue component,
// no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SHEET_FIT,
  SHEET_FIT_MODES,
  SNAP_FULL_PX,
  lieuAimPx,
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

test("a fit that leaves the map's controls no room above it goes full", () => {
  // The controls need 111 px (a 103 px corner and its margin): 92 px of map
  // left (Hautes-Alpes on a 360×740 phone) goes full, 111 fits.
  assert.equal(raisedOffset({ ...base, contentPx: 583, minOffsetPx: 111 }), 0);
  assert.equal(raisedOffset({ ...base, contentPx: 564, minOffsetPx: 111 }), 111);
  assert.equal(raisedOffset({ ...base, contentPx: 300, minOffsetPx: 111 }), 375);
  // Never below the sliver's own threshold.
  assert.equal(raisedOffset({ ...base, contentPx: 675 - 40, minOffsetPx: 10 }), 0);
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

test("an open audition's text on its way: the sheet stands full, whatever the rest", () => {
  assert.equal(raisedOffset({ ...base, contentPx: 300, expectFull: true }), 0);
  assert.equal(raisedOffset({ ...base, contentPx: 300, heldOffset: 375, expectFull: true }), 0);
  // Once the text is in (no longer expected), a short one fits again.
  assert.equal(raisedOffset({ ...base, contentPx: 300, expectFull: false }), 375);
  // « Plein » is full anyway.
  assert.equal(raisedOffset({ ...base, mode: "plein", contentPx: 300, expectFull: true }), 0);
});

test("the switch's default is one of its choices, the first", () => {
  assert.equal(DEFAULT_SHEET_FIT, "ajuste");
  assert.deepEqual([...SHEET_FIT_MODES], ["ajuste", "centre", "plein"]);
});

test("« Ajusté, centré » fits the sheet as « Ajusté » does", () => {
  for (const contentPx of [90, 300, 600, 2000])
    assert.equal(
      raisedOffset({ ...base, mode: "centre", contentPx }),
      raisedOffset({ ...base, contentPx }),
    );
});

test("an open lieu's pin is aimed above a short sheet only under « Ajusté, centré »", () => {
  const lieu = {
    mode: "centre" as const,
    lieuRaised: true,
    fitted: true,
    shownPx: 433.4,
    hold: false,
    expectFull: false,
    prev: null,
  };
  assert.equal(lieuAimPx(lieu), 433);
  // The other modes keep the top strip.
  assert.equal(lieuAimPx({ ...lieu, mode: "ajuste" }), null);
  assert.equal(lieuAimPx({ ...lieu, mode: "plein" }), null);
  // A full sheet, or one to stand full (an audition's text on its way): the top strip.
  assert.equal(lieuAimPx({ ...lieu, fitted: false }), null);
  assert.equal(lieuAimPx({ ...lieu, expectFull: true, prev: 433 }), null);
  // No lieu, or its sheet lowered: no aim.
  assert.equal(lieuAimPx({ ...lieu, lieuRaised: false, prev: 433 }), null);
  // While the sheet's content loads, the aim stays as it was.
  assert.equal(lieuAimPx({ ...lieu, hold: true, shownPx: 200, prev: 433 }), 433);
  assert.equal(lieuAimPx({ ...lieu, hold: true, prev: null }), null);
});

test("a sheet at rest refits in one step on a weak device and on a box change", () => {
  const rest = { fullChanged: false, short: false, easing: false };
  assert.equal(refitMotion(rest), "animate");
  assert.equal(refitMotion({ ...rest, short: true }), "snap");
  assert.equal(refitMotion({ ...rest, fullChanged: true }), "snap");
});

test("an ease still running carries the refit, on a weak device too", () => {
  // A pin's tap on a weak phone: the list changes as the sheet rises; the
  // raise eases on, retargeted, instead of jumping to its end.
  const ease = { fullChanged: false, short: false, easing: true };
  assert.equal(refitMotion(ease), "animate");
  assert.equal(refitMotion({ ...ease, short: true }), "animate");
  assert.equal(refitMotion({ ...ease, fullChanged: true }), "animate");
  assert.equal(refitMotion({ ...ease, short: true, fullChanged: true }), "animate");
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
