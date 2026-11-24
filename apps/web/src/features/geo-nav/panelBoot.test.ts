// The panel held under the boot curtain and its entrance (panelBoot.ts). Run
// with `node --import tsx --test` (root "test:scripts"). Pure: no Vue
// component, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CURTAIN_FADE_BELT_MS,
  DEFAULT_PANEL_BOOT,
  ENTRANCE_DESK_REM,
  ENTRANCE_FADE_MS,
  ENTRANCE_SHORT_MS,
  ENTRANCE_SLIDE_MS,
  PANEL_BOOT_MODES,
  panelEntrance,
  panelHeldAtBoot,
} from "./panelBoot";

test("the modes, the default first", () => {
  assert.deepEqual([...PANEL_BOOT_MODES], ["apres", "tout-de-suite"]);
  assert.equal(DEFAULT_PANEL_BOOT, "apres");
});

test("held only while the curtain is up or not fading yet, on the page, under « Après le chargement »", () => {
  const held = (booting: boolean, awaitingFade: boolean, preview = false) =>
    panelHeldAtBoot({ mode: "apres", booting, awaitingFade, mapFailed: false, preview });
  assert.equal(held(true, false), true);
  // Told to leave, its fade not started yet (a heavy first map frame): still held.
  assert.equal(held(false, true), true);
  // The curtain fading or gone, for whatever reason (ready, late, the cap,
  // the belt) but the map's fallback: the panel shows.
  assert.equal(held(false, false), false);
  // The home page's card shows no panel: nothing held.
  for (const booting of [true, false]) {
    for (const awaitingFade of [true, false]) {
      assert.equal(held(booting, awaitingFade, true), false);
    }
  }
  // « Tout de suite »: never held, as before.
  for (const booting of [true, false]) {
    for (const awaitingFade of [true, false]) {
      for (const preview of [true, false]) {
        assert.equal(
          panelHeldAtBoot({
            mode: "tout-de-suite",
            booting,
            awaitingFade,
            mapFailed: false,
            preview,
          }),
          false,
        );
      }
    }
  }
});

test("held while the map's fallback shows, whatever the boot says, never on the card", () => {
  for (const mode of PANEL_BOOT_MODES) {
    for (const booting of [true, false]) {
      for (const awaitingFade of [true, false]) {
        const at = (mapFailed: boolean, preview: boolean) =>
          panelHeldAtBoot({ mode, booting, awaitingFade, mapFailed, preview });
        assert.equal(at(true, false), true, `${mode} ${booting} ${awaitingFade}`);
        // The home page's card has no panel on show: nothing held.
        assert.equal(at(true, true), false);
        // The fallback gone (« Réessayer » brought the map): the boot's rule alone.
        assert.equal(
          at(false, false),
          mode === "apres" && (booting || awaitingFade),
          `${mode} ${booting} ${awaitingFade}`,
        );
      }
    }
  }
});

test("the fade belt outlasts the measured leave stall and stays short", () => {
  assert.ok(CURTAIN_FADE_BELT_MS > 1_400);
  assert.ok(CURTAIN_FADE_BELT_MS <= 3_000);
});

test("no entrance under reduced motion, whatever the device", () => {
  for (const tier of ["full", "light", "minimal"] as const) {
    for (const phone of [true, false]) {
      assert.deepEqual(panelEntrance({ phone, peekPx: 72, reduced: true, tier }), []);
    }
  }
});

test("a weak device: a short fade alone", () => {
  for (const tier of ["light", "minimal"] as const) {
    for (const phone of [true, false]) {
      const parts = panelEntrance({ phone, peekPx: 72, reduced: false, tier });
      assert.equal(parts.length, 1);
      assert.equal(parts[0].duration, ENTRANCE_SHORT_MS);
      assert.deepEqual(parts[0].keyframes, [{ opacity: 0 }, { opacity: 1 }]);
    }
  }
});

test("a phone's strip rises by its own height, a desktop's panel slides in by 2.5rem", () => {
  const phone = panelEntrance({ phone: true, peekPx: 71.6, reduced: false, tier: "full" });
  assert.equal(phone.length, 2);
  assert.deepEqual(phone[0].keyframes, [{ opacity: 0 }, { opacity: 1 }]);
  assert.equal(phone[0].duration, ENTRANCE_FADE_MS);
  assert.deepEqual(phone[1].keyframes, [{ translate: "0 72px" }, { translate: "0 0" }]);
  assert.equal(phone[1].duration, ENTRANCE_SLIDE_MS);
  // Only `translate` and `opacity`: the sheet's and the fold's transform is left alone.
  for (const p of phone) for (const k of p.keyframes) assert.ok(!("transform" in k));

  const desk = panelEntrance({ phone: false, peekPx: 72, reduced: false, tier: "full" });
  assert.deepEqual(desk[1].keyframes, [
    { translate: `${ENTRANCE_DESK_REM}rem 0` },
    { translate: "0 0" },
  ]);
  assert.equal(ENTRANCE_DESK_REM, 2.5);
  // A peek not measured yet never slides upward from above.
  const odd = panelEntrance({ phone: true, peekPx: -5, reduced: false, tier: "full" });
  assert.deepEqual(odd[1].keyframes[0], { translate: "0 0px" });
});
