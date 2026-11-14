// The lid cache's switch (lidCacheSwitch.ts), run with `node --import tsx
// --test` (root "test:scripts"): a build without the testing tools never
// reads its storage (a counting stub holding another value) and keeps the
// default; with the testing tools a kept key keeps its mode, the setter keeps
// the new one, and an unknown value or a storage that throws gives the
// default. The module is imported after the stubs (its mode is read at
// load), under a fresh query each time, as geo-nav/model/scopeHold.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };

let reads = 0;
const keeping = (values: Record<string, string>) => ({
  getItem(k: string) {
    reads++;
    return values[k] ?? null;
  },
  setItem(k: string, v: string) {
    values[k] = v;
  },
});

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./lidCacheSwitch.ts?mode=${++n}`)) as typeof import("./lidCacheSwitch");
}

test("without the testing tools: the default (on), storage unread, the setter ignored", async () => {
  const values = { "ac:lid-cache": "off" };
  g.localStorage = keeping(values);
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.DEFAULT_LID_CACHE, "on");
    assert.ok(m.LID_CACHE_MODES.includes(m.DEFAULT_LID_CACHE));
    assert.equal(m.lidCacheMode.value, m.DEFAULT_LID_CACHE);
    m.setLidCacheMode("off");
    assert.equal(m.lidCacheMode.value, m.DEFAULT_LID_CACHE);
    assert.equal(values["ac:lid-cache"], "off");
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: a kept key keeps its mode, and the setter keeps the new one", async () => {
  const values: Record<string, string> = { "ac:lid-cache": "off" };
  g.localStorage = keeping(values);
  try {
    const m = await load(true);
    assert.equal(m.lidCacheMode.value, "off");
    m.setLidCacheMode("on");
    assert.equal(m.lidCacheMode.value, "on");
    assert.deepEqual(values, { "ac:lid-cache": "on" });
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: an unknown value or a storage that throws gives the default", async () => {
  g.localStorage = keeping({ "ac:lid-cache": "oui" });
  try {
    assert.equal((await load(true)).lidCacheMode.value, "on");
  } finally {
    delete g.localStorage;
  }
  g.localStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  try {
    const m = await load(true);
    assert.equal(m.lidCacheMode.value, "on");
    m.setLidCacheMode("off"); // lasts for this page
    assert.equal(m.lidCacheMode.value, "off");
  } finally {
    delete g.localStorage;
  }
});
