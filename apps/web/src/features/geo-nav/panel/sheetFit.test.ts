// A phone's raised sheet as tall as its content (sheetFit.ts): the offset
// from the full box, the minimum, the snaps to full (a sliver of map, no
// room for the map's controls), the hold while loading, the camera's aim
// under « Ajusté, centré » (an open lieu's pin; the band a territory is
// framed in above a short sheet and when a new band frames it again), how a
// refit moves and where a released drag settles. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue component,
// no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BAND_MARGIN_PX,
  DEFAULT_SHEET_FIT,
  MIN_BAND_REM,
  DEFAULT_SHEET_LATE,
  SHEET_LATE_MODES,
  bandHolds,
  bandMoved,
  bandReframe,
  sheetBandInsets,
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

// « Ajusté, centré »: the band a territory in scope is framed in above a short
// sheet. A 360×740 phone, the header's tiles 51 px down, the camera's 36 px
// beside, a sheet of 5 rows covering 316 px of the screen's bottom.
const band = {
  mode: "centre" as const,
  phone: true,
  raised: true,
  fitted: true,
  lieuOpen: false,
  shownPx: 316,
  viewportH: 740,
  headerClearPx: 51,
  sidePx: 36,
  remPx: 16,
};

test("the band is the map between the header's tiles and the short sheet, a margin inside", () => {
  assert.deepEqual(sheetBandInsets(band), {
    top: 51 + BAND_MARGIN_PX,
    bottom: 316 + BAND_MARGIN_PX,
    left: 36,
    right: 36,
  });
  // Rounded to whole pixels.
  assert.deepEqual(sheetBandInsets({ ...band, shownPx: 316.4, headerClearPx: 50.6 }), {
    top: 63,
    bottom: 328,
    left: 36,
    right: 36,
  });
});

test("no band but under « Ajusté, centré », on a phone, over a raised short sheet, no lieu open", () => {
  assert.equal(sheetBandInsets({ ...band, mode: "ajuste" }), null);
  assert.equal(sheetBandInsets({ ...band, mode: "plein" }), null);
  assert.equal(sheetBandInsets({ ...band, phone: false }), null);
  assert.equal(sheetBandInsets({ ...band, raised: false }), null);
  // A full sheet (a long list, an opening audition): framed as today.
  assert.equal(sheetBandInsets({ ...band, fitted: false }), null);
  // A lieu's pin is aimed by the camera's padding (lieuAimPx).
  assert.equal(sheetBandInsets({ ...band, lieuOpen: true }), null);
  // Nothing measured yet.
  assert.equal(sheetBandInsets({ ...band, shownPx: 0 }), null);
  assert.equal(sheetBandInsets({ ...band, viewportH: 0 }), null);
});

test("a band too short to frame a territory in is none", () => {
  const min = MIN_BAND_REM * 16;
  // 740 − 63 − (shown + 12) = min: just enough.
  const shownFits = 740 - 63 - 12 - min;
  assert.notEqual(sheetBandInsets({ ...band, shownPx: shownFits }), null);
  assert.equal(sheetBandInsets({ ...band, shownPx: shownFits + 1 }), null);
});

test("a band holds another that it reaches past on every edge, within the tolerance", () => {
  const a = { top: 63, bottom: 328, left: 36, right: 36 };
  // The sheet came down: more map above it.
  assert.equal(bandHolds(a, { ...a, bottom: 210 }), true);
  assert.equal(bandHolds(a, a), true);
  assert.equal(bandHolds(a, { ...a, bottom: 344 }), true);
  // The sheet went up past the tolerance: the territory may be under it.
  assert.equal(bandHolds(a, { ...a, bottom: 345 }), false);
  assert.equal(bandHolds(a, { ...a, top: 80, bottom: 200 }), false);
  assert.equal(bandHolds(a, { ...a, bottom: 334 }, 4), false);
  assert.equal(bandHolds(a, null), false);
  assert.equal(bandHolds(null, a), false);
});

test("a band moves past its tolerance, and always to or from none", () => {
  const a = { top: 63, bottom: 328, left: 36, right: 36 };
  assert.equal(bandMoved(a, { ...a, bottom: 344 }), false);
  assert.equal(bandMoved(a, { ...a, bottom: 345 }), true);
  assert.equal(bandMoved(a, { ...a, top: 47 }), false);
  assert.equal(bandMoved(a, { ...a, left: 53 }), true);
  assert.equal(bandMoved(a, { ...a, bottom: 334 }, 4), true);
  assert.equal(bandMoved(a, null), true);
  assert.equal(bandMoved(null, a), true);
  assert.equal(bandMoved(null, null), false);
});

test("a new band frames the scope again only where the scope may move with it", () => {
  const rest = {
    dialog: false,
    toNone: false,
    grewOnly: false,
    afterHold: false,
    late: "rester" as "rester" | "recentrer",
    inFlight: false,
    hold: false,
    readingPlace: false,
    microZone: false,
    listMode: false,
    inHands: false,
    movedSinceCommand: false,
    short: false,
  };
  const table: [Partial<typeof rest>, string][] = [
    [{}, "fit"],
    [{ short: true }, "instant"],
    [{ inFlight: true }, "retarget"],
    [{ inFlight: true, short: true }, "retarget"],
    [{ inFlight: true, hold: true }, "retarget"],
    [{ hold: true }, "wait"],
    [{ hold: true, short: true }, "wait"],
    [{ movedSinceCommand: true }, "keep"],
    [{ movedSinceCommand: true, inFlight: true }, "keep"],
    [{ inHands: true }, "later"],
    [{ inHands: true, movedSinceCommand: true }, "later"],
    [{ listMode: true }, "filter"],
    [{ listMode: true, inHands: true }, "filter"],
    [{ readingPlace: true }, "hold"],
    [{ microZone: true }, "hold"],
    [{ microZone: true, listMode: true, inFlight: true }, "hold"],
    // The filters' dialog over the page: nothing until it closes.
    [{ dialog: true }, "dialog"],
    [{ dialog: true, listMode: true, inFlight: true }, "dialog"],
    // No fit may come and the band wanted is none (lowered after a hand
    // moved the map, or in the lieu zone): the band goes alone.
    [{ movedSinceCommand: true, toNone: true }, "drop"],
    [{ microZone: true, toNone: true }, "drop"],
    [{ readingPlace: true, toNone: true }, "drop"],
    [{ inHands: true, movedSinceCommand: true, toNone: true }, "later"],
    [{ listMode: true, toNone: true }, "filter"],
    // A fit may come: lowered, the map is framed again with the band gone.
    [{ toNone: true }, "fit"],
    [{ toNone: true, inFlight: true }, "retarget"],
    // A late list (a hold since the tap) leaving more map above the sheet
    // once the flight has landed: left where it is under « Rester »…
    [{ grewOnly: true, afterHold: true }, "stay"],
    [{ grewOnly: true, afterHold: true, short: true }, "stay"],
    // …framed again under « Recentrer », or when the map only grew without a
    // hold (no late list), or when the band shrank (the sheet went up).
    [{ grewOnly: true, afterHold: true, late: "recentrer" }, "fit"],
    [{ grewOnly: true }, "fit"],
    [{ afterHold: true }, "fit"],
    [{ afterHold: true, short: true }, "instant"],
    // Still in the air, or still on its way: as before.
    [{ grewOnly: true, afterHold: true, inFlight: true }, "retarget"],
    [{ grewOnly: true, afterHold: true, hold: true }, "wait"],
    [{ grewOnly: true, afterHold: true, movedSinceCommand: true }, "keep"],
  ];
  for (const [over, want] of table) {
    assert.equal(bandReframe({ ...rest, ...over }), want, JSON.stringify(over));
  }
});

test("« Recadrage tardif »: « Rester » first and by default", () => {
  assert.deepEqual([...SHEET_LATE_MODES], ["rester", "recentrer"]);
  assert.equal(DEFAULT_SHEET_LATE, "rester");
});
