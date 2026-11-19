// The cards' gutter switch (cardsBleedSwitch.ts): each mode's class on the
// panel list, and a build without the testing tools reading no key (the
// default, whatever is stored) and ignoring the setter. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue component.

import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map<string, string>([["ac:cards-bleed", "marge"]]);
const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage: Storage };
g.__TEST_TOOLS__ = false;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { CARDS_BLEEDS, DEFAULT_CARDS_BLEED, cardsBleed, cardsBleedClass, setCardsBleed } =
  await import("./cardsBleedSwitch");

test("each mode gives the list its class: everywhere, phones only, none", () => {
  assert.deepEqual(
    CARDS_BLEEDS.map((m) => cardsBleedClass(m)),
    ["bleed", "bleed-phone", null],
  );
  assert.equal(DEFAULT_CARDS_BLEED, "partout");
  assert.equal(cardsBleedClass(DEFAULT_CARDS_BLEED), "bleed");
});

test("without the testing tools the stored key is not read and the setter does nothing", () => {
  assert.equal(cardsBleed.value, DEFAULT_CARDS_BLEED);
  setCardsBleed("telephone");
  assert.equal(cardsBleed.value, DEFAULT_CARDS_BLEED);
  assert.equal(store.get("ac:cards-bleed"), "marge");
});
