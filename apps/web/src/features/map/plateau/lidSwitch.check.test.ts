// The ac:lid-check switch (lidSwitch.ts) against a stubbed localStorage, run
// with `node --import tsx --test` (root "test:scripts"): the page's value with
// and without the testing tools (the module read again under a fresh query),
// garbage and a throwing storage, and the lid mode left to its own key.

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
  return (await import(`./lidSwitch.ts?load=${++n}`)) as typeof import("./lidSwitch");
}

test("lidCheck: the kept value with the testing tools, else the default", async () => {
  stored = {};
  const m = await load(true);
  assert.equal(m.DEFAULT_LID_CHECK, "signaux");
  assert.equal(m.lidCheck, "signaux");
  stored = { "ac:lid-check": "pixels" };
  assert.equal((await load(true)).lidCheck, "pixels");
  stored = { "ac:lid-check": "signaux" };
  assert.equal((await load(true)).lidCheck, "signaux");
  for (const garbage of ["", "Pixels", "pixel", "ecran", " signaux"]) {
    stored = { "ac:lid-check": garbage };
    assert.equal((await load(true)).lidCheck, "signaux", garbage);
  }
  stored = { "ac:lid-check": "pixels" };
  throwing = true;
  assert.equal((await load(true)).lidCheck, "signaux");
  throwing = false;
  // Without the testing tools a kept value is ignored.
  assert.equal((await load(false)).lidCheck, "signaux");
});

test("setLidCheck: kept and reloaded, a no-op without the testing tools or on the same value", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true); // "signaux"
  m.setLidCheck("signaux");
  assert.deepEqual([stored, reloads], [{}, 0]);
  m.setLidCheck("pixels");
  assert.deepEqual([stored, reloads], [{ "ac:lid-check": "pixels" }, 1]);
  stored = {};
  const off = await load(false);
  g.__TEST_TOOLS__ = false;
  off.setLidCheck("pixels");
  assert.deepEqual([stored, reloads], [{}, 1]);
});

test("lidMode: unchanged by the new key", async () => {
  stored = { "ac:lid-check": "pixels" };
  assert.equal((await load(true)).lidMode, "ecran");
  stored = { "ac:lid-check": "pixels", "ac:lid": "aucun" };
  const m = await load(true);
  assert.deepEqual([m.lidMode, m.lidCheck], ["aucun", "pixels"]);
});
