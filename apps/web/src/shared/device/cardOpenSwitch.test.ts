// The home card's opening (cardOpenSwitch.ts), the map's fallback
// (features/map/fallbackSwitch.ts) and the curtain's picture
// (shared/ui/posterSwitch.ts), run with `node --import tsx --test` (root
// "test:scripts"): each rule, each default, and each switch read only with the
// testing tools (garbage and blocked storage read as the default).

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };
g.__TEST_TOOLS__ = false;
const open = await import("./cardOpenSwitch");
const fallback = await import("../../features/map/fallbackSwitch");
const poster = await import("../ui/posterSwitch");

const TIERS = ["full", "light", "minimal"] as const;

test("the card grows on a full device under « Auto », never under reduced motion", () => {
  assert.deepEqual(
    TIERS.map((t) => open.cardGrows("auto", t, false)),
    [true, false, false],
  );
  for (const t of TIERS) {
    assert.equal(open.cardGrows("grandir", t, false), true, t);
    assert.equal(open.cardGrows("direct", t, false), false, t);
    for (const m of open.CARD_OPENS) assert.equal(open.cardGrows(m, t, true), false, `${m}/${t}`);
  }
});

test("the map's fallback: the visitor's picture and sentence, the old hint, the forced one", () => {
  assert.deepEqual(fallback.fallbackView("visiteur"), { poster: true, developerHint: false });
  assert.deepEqual(fallback.fallbackView("essai"), { poster: true, developerHint: false });
  assert.deepEqual(fallback.fallbackView("ancien"), { poster: false, developerHint: true });
  assert.deepEqual(fallback.MAP_FALLBACKS.map(fallback.fallbackForced), [false, false, true]);
  // Plain French, for visitors: no variable, no file.
  assert.doesNotMatch(fallback.MAP_FALLBACK_TEXT, /VITE|\.env|token/i);
  assert.ok(fallback.MAP_FALLBACK_TEXT.endsWith("."));
});

test("the curtain shows France with « france » alone", () => {
  assert.deepEqual(poster.POSTERS.map(poster.curtainPoster), [false, true]);
});

test("the defaults; a build without the testing tools reads no storage", () => {
  assert.equal(open.DEFAULT_CARD_OPEN, "auto");
  assert.equal(open.cardOpen, "auto");
  assert.equal(fallback.DEFAULT_MAP_FALLBACK, "visiteur");
  assert.equal(fallback.mapFallback, "visiteur");
  assert.equal(poster.DEFAULT_POSTER, "non");
  assert.equal(poster.poster, "non");
});

test("the stored modes are read back, garbage and blocked storage as the default", () => {
  const kept = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => kept.get(k) ?? null };
  kept.set("ac:card-open", "direct");
  kept.set("ac:map-fallback", "essai");
  kept.set("ac:poster", "france");
  assert.equal(open.storedCardOpen(), "direct");
  assert.equal(fallback.storedMapFallback(), "essai");
  assert.equal(poster.storedPoster(), "france");
  for (const k of kept.keys()) kept.set(k, "nonsense");
  assert.equal(open.storedCardOpen(), "auto");
  assert.equal(fallback.storedMapFallback(), "visiteur");
  assert.equal(poster.storedPoster(), "non");
  g.localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(open.storedCardOpen(), "auto");
  assert.equal(fallback.storedMapFallback(), "visiteur");
  assert.equal(poster.storedPoster(), "non");
  delete g.localStorage;
});
