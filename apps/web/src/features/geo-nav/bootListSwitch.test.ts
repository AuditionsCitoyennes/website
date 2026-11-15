// The boot curtain's switch (bootListSwitch.ts): what the curtain covers for
// each mode and for the home page's card, and the kept mode read back from
// storage (a garbage value, an empty or blocked storage give the default).
// Run with `node --import tsx --test` (root "test:scripts"). Pure: no Vue
// component, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const { BOOT_LISTS, DEFAULT_BOOT_LIST, bootCurtainCover, bootList, storedBootList } =
  await import("./bootListSwitch");

/** A localStorage stand-in for one test, removed after it. */
function withStorage(storage: unknown, run: () => void) {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const before = g.localStorage;
  Object.defineProperty(g, "localStorage", { value: storage, configurable: true });
  try {
    run();
  } finally {
    if (had) Object.defineProperty(g, "localStorage", { value: before, configurable: true });
    else delete g.localStorage;
  }
}
const kept = (value: string | null) => ({
  getItem: (k: string) => (k === "ac:boot-list" ? value : null),
});

test("the default lists first, and a build without the testing tools uses it", () => {
  assert.equal(DEFAULT_BOOT_LIST, "first");
  assert.deepEqual([...BOOT_LISTS], ["first", "curtain"]);
  assert.equal(bootList, DEFAULT_BOOT_LIST);
});

test("the curtain covers the map's box alone with « first », the whole page otherwise", () => {
  assert.equal(bootCurtainCover("first", false), "map");
  assert.equal(bootCurtainCover("curtain", false), "all");
  // The home page's card has no panel to show: the whole curtain, whatever the switch.
  assert.equal(bootCurtainCover("first", true), "all");
  assert.equal(bootCurtainCover("curtain", true), "all");
});

test("the kept mode is read back; anything else gives the default", () => {
  withStorage(kept("curtain"), () => assert.equal(storedBootList(), "curtain"));
  withStorage(kept("first"), () => assert.equal(storedBootList(), "first"));
  withStorage(kept(null), () => assert.equal(storedBootList(), "first"));
  withStorage(kept("rideau"), () => assert.equal(storedBootList(), "first"));
  withStorage(
    {
      getItem() {
        throw new Error("blocked");
      },
    },
    () => assert.equal(storedBootList(), "first"),
  );
});
