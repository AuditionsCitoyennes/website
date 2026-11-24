// The home card's opening (cardOpenSwitch.ts) and the map's fallback
// sentence (features/map/fallback.ts), run with `node --import tsx --test`
// (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean };
g.__TEST_TOOLS__ = false;
const open = await import("./cardOpenSwitch");
const fallback = await import("../../features/map/fallback");

const TIERS = ["full", "light", "minimal"] as const;

test("the card grows on a full device, never under reduced motion", () => {
  assert.deepEqual(
    TIERS.map((t) => open.cardGrows(t, false)),
    [true, false, false],
  );
  for (const t of TIERS) assert.equal(open.cardGrows(t, true), false, t);
});

test("the map's fallback: the visitor's sentence", () => {
  // Plain French, for visitors: no variable, no file.
  assert.doesNotMatch(fallback.MAP_FALLBACK_TEXT, /VITE|\.env|token/i);
  assert.ok(fallback.MAP_FALLBACK_TEXT.endsWith("."));
});
