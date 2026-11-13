// The glass switch (glassSwitch.ts), run with `node --import tsx --test` (root
// "test:scripts"): « Auto » blurs on the full tier alone, the two forced
// modes on every tier, the attribute <html> gets, and the switch read only
// with the testing tools (garbage and blocked storage read as the default).

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };
g.__TEST_TOOLS__ = false;
const glass = await import("./glassSwitch");
const { DEFAULT_GLASS, GLASSES, glassAttribute, glassBlurs, storedGlass } = glass;

const TIERS = ["full", "light", "minimal"] as const;

test("« Auto » blurs on a full device only; the forced modes ignore the tier", () => {
  assert.deepEqual(
    TIERS.map((t) => glassBlurs("auto", t)),
    [true, false, false],
  );
  for (const t of TIERS) {
    assert.equal(glassBlurs("flou", t), true, t);
    assert.equal(glassBlurs("plein", t), false, t);
  }
});

test("the attribute is « plein » exactly when the glass does not blur", () => {
  for (const mode of GLASSES) {
    for (const t of TIERS) {
      assert.equal(glassAttribute(mode, t), glassBlurs(mode, t) ? null : "plein", `${mode}/${t}`);
    }
  }
});

test("the default is « auto », and a build without the testing tools reads no storage", () => {
  assert.equal(DEFAULT_GLASS, "auto");
  assert.equal(glass.glass, "auto");
});

test("the stored mode is read back, garbage and blocked storage as the default", () => {
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null };
  try {
    assert.equal(storedGlass(), "auto");
    store.set("ac:glass", "plein");
    assert.equal(storedGlass(), "plein");
    store.set("ac:glass", "flou");
    assert.equal(storedGlass(), "flou");
    store.set("ac:glass", "verre");
    assert.equal(storedGlass(), "auto");
    g.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(storedGlass(), "auto");
  } finally {
    delete g.localStorage;
  }
});
