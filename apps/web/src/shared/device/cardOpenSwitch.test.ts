// The home card's opening (cardOpenSwitch.ts) and the map's fallback
// (features/map/fallbackSwitch.ts), run with `node --import tsx --test` (root
// "test:scripts"): each rule, each default, and the fallback's switch read
// only with the testing tools (garbage and blocked storage read as the
// default).

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };
g.__TEST_TOOLS__ = false;
const open = await import("./cardOpenSwitch");
const fallback = await import("../../features/map/fallbackSwitch");

const TIERS = ["full", "light", "minimal"] as const;

test("the card grows on a full device, never under reduced motion", () => {
  assert.deepEqual(
    TIERS.map((t) => open.cardGrows(t, false)),
    [true, false, false],
  );
  for (const t of TIERS) assert.equal(open.cardGrows(t, true), false, t);
});

test("the map's fallback: the visitor's sentence, and the forced one", () => {
  assert.deepEqual(fallback.MAP_FALLBACKS.map(fallback.fallbackForced), [false, true]);
  // Plain French, for visitors: no variable, no file.
  assert.doesNotMatch(fallback.MAP_FALLBACK_TEXT, /VITE|\.env|token/i);
  assert.ok(fallback.MAP_FALLBACK_TEXT.endsWith("."));
});

test("the default; a build without the testing tools reads no storage", () => {
  assert.equal(fallback.DEFAULT_MAP_FALLBACK, "visiteur");
  assert.equal(fallback.mapFallback, "visiteur");
});

test("the stored mode is read back, garbage and blocked storage as the default", () => {
  const kept = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => kept.get(k) ?? null };
  kept.set("ac:map-fallback", "essai");
  assert.equal(fallback.storedMapFallback(), "essai");
  kept.set("ac:map-fallback", "ancien");
  assert.equal(fallback.storedMapFallback(), "visiteur");
  g.localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(fallback.storedMapFallback(), "visiteur");
  delete g.localStorage;
});
