// The curtain poster's switch (bootPosterSwitch.ts): a build without the
// testing tools draws the default and reads no storage; the stored choice is
// read with garbage and blocked storage falling back to the default. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const store = new Map<string, string>();
let blocked = false;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => {
    if (blocked) throw new Error("blocked");
    return store.get(k) ?? null;
  },
};
const sw = await import("./bootPosterSwitch");

test("a build without the testing tools draws the default", () => {
  assert.equal(sw.bootPosterMode, sw.DEFAULT_BOOT_POSTER);
  assert.equal(sw.DEFAULT_BOOT_POSTER, "carte");
  assert.deepEqual([...sw.BOOT_POSTERS], ["carte", "plat", "avant"]);
  // Its setter does nothing there.
  sw.setBootPosterMode("avant");
});

test("the stored choice, else the default", () => {
  assert.equal(sw.storedBootPoster(), "carte");
  store.set("ac:boot-poster", "avant");
  assert.equal(sw.storedBootPoster(), "avant");
  store.set("ac:boot-poster", "penchée");
  assert.equal(sw.storedBootPoster(), "carte");
  blocked = true;
  assert.equal(sw.storedBootPoster(), "carte");
});
