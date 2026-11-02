// The ac:relief-prefetch switch (reliefSwitch.ts) against a stubbed
// localStorage, run with `node --import tsx --test` (root "test:scripts"): the
// kept value, garbage and a throwing storage, and the page's value with and
// without the testing tools (the module read again under a fresh query).

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  localStorage?: unknown;
  window?: unknown;
};
let stored: Record<string, string> = {};
let throwing = false;
let reloads = 0;
g.localStorage = {
  getItem(k: string) {
    if (throwing) throw new Error("blocked");
    return stored[k] ?? null;
  },
  setItem(k: string, v: string) {
    if (throwing) throw new Error("blocked");
    stored[k] = v;
  },
};
g.window = { location: { reload: () => reloads++ } };

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./reliefSwitch.ts?load=${++n}`)) as typeof import("./reliefSwitch");
}

test("storedReliefPrefetch: the kept value, else the default", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_RELIEF_PREFETCH, "hillshade");
  stored = { "ac:relief-prefetch": "terrain0" };
  assert.equal(m.storedReliefPrefetch(), "terrain0");
  stored = { "ac:relief-prefetch": "hillshade" };
  assert.equal(m.storedReliefPrefetch(), "hillshade");
  for (const garbage of ["", "Terrain0", "terrain", "client", " hillshade"]) {
    stored = { "ac:relief-prefetch": garbage };
    assert.equal(m.storedReliefPrefetch(), "hillshade", garbage);
  }
  stored = {};
  assert.equal(m.storedReliefPrefetch(), "hillshade");
  throwing = true;
  assert.equal(m.storedReliefPrefetch(), "hillshade");
  throwing = false;
});

test("reliefPrefetch: the kept value with the testing tools only", async () => {
  stored = { "ac:relief-prefetch": "terrain0" };
  assert.equal((await load(true)).reliefPrefetch, "terrain0");
  assert.equal((await load(false)).reliefPrefetch, "hillshade");
  throwing = true;
  assert.equal((await load(true)).reliefPrefetch, "hillshade");
  throwing = false;
});

test("setReliefPrefetch: kept and reloaded, a no-op without the testing tools or on the same value", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true); // "hillshade"
  m.setReliefPrefetch("hillshade");
  assert.deepEqual([stored, reloads], [{}, 0]);
  m.setReliefPrefetch("terrain0");
  assert.deepEqual([stored, reloads], [{ "ac:relief-prefetch": "terrain0" }, 1]);
  stored = {};
  const off = await load(false);
  g.__TEST_TOOLS__ = false;
  off.setReliefPrefetch("terrain0");
  assert.deepEqual([stored, reloads], [{}, 1]);
});
