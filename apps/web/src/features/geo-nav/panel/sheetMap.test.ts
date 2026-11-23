// What a phone's raised sheet does when the visitor uses the map
// (sheetMap.ts): « Baisser le panneau » lowers it on a gesture's start made
// by hand and on a tap that is not a lieu's; « Ne rien faire » is the rule of
// before (usePanelLayout's engageMap: only an open lieu's gesture lowers it).
// Run with `node --import tsx --test` (root "test:scripts"). Pure: no Vue
// component, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_TAIL_MS } from "../model/lieuFollow";
import {
  DEFAULT_SHEET_MAP,
  SHEET_MAP_MODES,
  createGestureFirst,
  sheetLowersOnMap,
  type MapUse,
  type SheetMapInputs,
} from "./sheetMap";

const raised: SheetMapInputs = {
  mode: "baisser",
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

/** The phone branch of engageMap before this rule, as origin/dev wrote it: a
 *  gesture with a lieu open, past the tail of the tap that opened it, the
 *  sheet not under a finger; taps never lowered the sheet. It never read the
 *  home card (`preview`): there the whole page is inert (GeoNav's
 *  `.geo-page`), no gesture or tap reaches the map, so the card is compared
 *  apart (below), not against this. */
function before(i: SheetMapInputs): boolean {
  if (!i.phone || i.use.kind !== "gesture") return false;
  if (!i.lieuOpen || i.sinceLieuOpenMs < 400) return false;
  return !i.sheetDragging;
}

test("the choices, the default first", () => {
  assert.deepEqual([...SHEET_MAP_MODES], ["baisser", "rien"]);
  assert.equal(DEFAULT_SHEET_MAP, "baisser");
  assert.equal(SHEET_MAP_MODES[0], DEFAULT_SHEET_MAP);
  assert.equal(OPEN_TAIL_MS, 400);
});

test("« Ne rien faire » is the rule of before, case by case (off the card)", () => {
  for (const use of USES)
    for (const phone of [true, false])
      for (const isRaised of [true, false])
        for (const sheetDragging of [false, true])
          for (const lieuOpen of [false, true])
            for (const sinceLieuOpenMs of [0, 399, 400, 5000]) {
              const i: SheetMapInputs = {
                mode: "rien",
                phone,
                preview: false,
                raised: isRaised,
                sheetDragging,
                lieuOpen,
                sinceLieuOpenMs,
                use,
              };
              assert.equal(sheetLowersOnMap(i), before(i), JSON.stringify(i));
            }
});

test("the home card (inert on dev and here): nothing lowers, under both choices", () => {
  for (const mode of SHEET_MAP_MODES)
    for (const use of USES)
      for (const lieuOpen of [false, true])
        assert.equal(
          sheetLowersOnMap({
            ...raised,
            mode,
            preview: true,
            lieuOpen,
            sinceLieuOpenMs: 5000,
            use,
          }),
          false,
        );
});

test("« Baisser le panneau »: a hand's first signal and a tap off a lieu lower the sheet", () => {
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

test("an open lieu: any gesture past the tail of its tap, under both choices", () => {
  for (const mode of SHEET_MAP_MODES)
    for (const source of ["hand", "keys", "controls"] as const)
      for (const first of [true, false]) {
        const i: SheetMapInputs = {
          ...raised,
          mode,
          lieuOpen: true,
          use: { kind: "gesture", source, first },
        };
        assert.equal(sheetLowersOnMap({ ...i, sinceLieuOpenMs: OPEN_TAIL_MS - 1 }), false);
        assert.equal(sheetLowersOnMap({ ...i, sinceLieuOpenMs: OPEN_TAIL_MS }), true);
        // As before: the raise is not read (a lowered sheet set lowered again).
        assert.equal(
          sheetLowersOnMap({ ...i, raised: false, sinceLieuOpenMs: OPEN_TAIL_MS }),
          true,
        );
        assert.equal(sheetLowersOnMap({ ...i, sheetDragging: true, sinceLieuOpenMs: 5000 }), false);
      }
});

test("an open lieu: a tap on a territory lowers, on a lieu's dot it does not", () => {
  const open = { ...raised, lieuOpen: true, sinceLieuOpenMs: 5000 };
  assert.equal(sheetLowersOnMap({ ...open, use: { kind: "tap", target: "territory" } }), true);
  assert.equal(sheetLowersOnMap({ ...open, use: { kind: "tap", target: "empty" } }), true);
  assert.equal(sheetLowersOnMap({ ...open, use: { kind: "tap", target: "lieu" } }), false);
  assert.equal(
    sheetLowersOnMap({ ...open, mode: "rien", use: { kind: "tap", target: "territory" } }),
    false,
  );
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
