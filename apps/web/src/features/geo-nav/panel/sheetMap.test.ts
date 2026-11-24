// What a phone's raised sheet does when the visitor uses the map
// (sheetMap.ts): it lowers on a gesture's start made by hand and on a tap
// that is not a lieu's; with a lieu open, on any gesture past the tail of
// the tap that opened it.
// Run with `node --import tsx --test` (root "test:scripts"). Pure: no Vue
// component, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_TAIL_MS } from "../model/lieuFollow";
import { createGestureFirst, sheetLowersOnMap, type MapUse, type SheetMapInputs } from "./sheetMap";

const raised: SheetMapInputs = {
  phone: true,
  preview: false,
  raised: true,
  sheetDragging: false,
  lieuOpen: false,
  sinceLieuOpenMs: 0,
  use: { kind: "gesture", source: "hand", first: true },
};

const USES: MapUse[] = [
  { kind: "gesture", source: "hand", first: true },
  { kind: "gesture", source: "hand", first: false },
  { kind: "gesture", source: "keys", first: true },
  { kind: "gesture", source: "keys", first: false },
  { kind: "gesture", source: "controls", first: true },
  { kind: "gesture", source: "controls", first: false },
  { kind: "tap", target: "empty" },
  { kind: "tap", target: "territory" },
  { kind: "tap", target: "lieu" },
];

test("an open lieu's tail is the lieu follow's", () => {
  assert.equal(OPEN_TAIL_MS, 400);
});

test("the home card (inert anyway): nothing lowers", () => {
  for (const use of USES)
    for (const lieuOpen of [false, true])
      assert.equal(
        sheetLowersOnMap({
          ...raised,
          preview: true,
          lieuOpen,
          sinceLieuOpenMs: 5000,
          use,
        }),
        false,
      );
});

test("a hand's first signal and a tap off a lieu lower the sheet", () => {
  const got = USES.map((use) => sheetLowersOnMap({ ...raised, use }));
  assert.deepEqual(got, [true, false, false, false, false, false, true, true, false]);
});

test("nothing lowers a sheet that is down, under a finger, on a desktop or on the card", () => {
  for (const use of USES) {
    assert.equal(sheetLowersOnMap({ ...raised, raised: false, use }), false);
    assert.equal(sheetLowersOnMap({ ...raised, sheetDragging: true, use }), false);
    assert.equal(sheetLowersOnMap({ ...raised, phone: false, use }), false);
    assert.equal(sheetLowersOnMap({ ...raised, preview: true, use }), false);
  }
});

test("an open lieu: any gesture past the tail of its tap", () => {
  for (const source of ["hand", "keys", "controls"] as const)
    for (const first of [true, false]) {
      const i: SheetMapInputs = {
        ...raised,
        lieuOpen: true,
        use: { kind: "gesture", source, first },
      };
      assert.equal(sheetLowersOnMap({ ...i, sinceLieuOpenMs: OPEN_TAIL_MS - 1 }), false);
      assert.equal(sheetLowersOnMap({ ...i, sinceLieuOpenMs: OPEN_TAIL_MS }), true);
      // As before: the raise is not read (a lowered sheet set lowered again).
      assert.equal(sheetLowersOnMap({ ...i, raised: false, sinceLieuOpenMs: OPEN_TAIL_MS }), true);
      assert.equal(sheetLowersOnMap({ ...i, sheetDragging: true, sinceLieuOpenMs: 5000 }), false);
    }
});

test("an open lieu: a tap on a territory lowers, on a lieu's dot it does not", () => {
  const open = { ...raised, lieuOpen: true, sinceLieuOpenMs: 5000 };
  assert.equal(sheetLowersOnMap({ ...open, use: { kind: "tap", target: "territory" } }), true);
  assert.equal(sheetLowersOnMap({ ...open, use: { kind: "tap", target: "empty" } }), true);
  assert.equal(sheetLowersOnMap({ ...open, use: { kind: "tap", target: "lieu" } }), false);
});

test("a gesture's first signal, told from its repeats", () => {
  const first = createGestureFirst();
  assert.equal(first(1), true);
  assert.equal(first(1), false); // the same gesture said again as it glides on
  assert.equal(first(1), false);
  assert.equal(first(2), true); // a new gesture
  assert.equal(first(), true); // no number: a use of its own, always first…
  assert.equal(first(2), false); // …and it does not count as a gesture seen
  assert.equal(first(3), true);
  // Each layout its own count.
  const other = createGestureFirst();
  assert.equal(other(3), true);
});
