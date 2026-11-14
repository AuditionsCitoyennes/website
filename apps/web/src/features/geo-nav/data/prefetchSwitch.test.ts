// The idle prefetch's switch (prefetchSwitch.ts), run with `node --import tsx
// --test` (root "test:scripts"): a build without the testing tools never
// reads its storage (a counting stub holding another value) and keeps the
// default; with the testing tools a kept key keeps its mode, the setter keeps
// the new one, and an unknown value or a storage that throws gives the
// default. The module is imported after the stubs (its mode is read at
// load), under a fresh query each time, as model/scopeHold.test.ts.

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
  return (await import(`./prefetchSwitch.ts?mode=${++n}`)) as typeof import("./prefetchSwitch");
}

test("without the testing tools: the default (idle), storage unread, the setter ignored", async () => {
  const values = { "ac:outlines-ahead": "off" };
  g.localStorage = keeping(values);
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.DEFAULT_PREFETCH, "idle");
    assert.ok(m.PREFETCH_MODES.includes(m.DEFAULT_PREFETCH));
    assert.equal(m.prefetchMode.value, m.DEFAULT_PREFETCH);
    m.setPrefetchMode("off");
    assert.equal(m.prefetchMode.value, m.DEFAULT_PREFETCH);
    assert.equal(values["ac:outlines-ahead"], "off");
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: a kept key keeps its mode, and the setter keeps the new one", async () => {
  const values: Record<string, string> = { "ac:outlines-ahead": "off" };
  g.localStorage = keeping(values);
  try {
    const m = await load(true);
    assert.equal(m.prefetchMode.value, "off");
    m.setPrefetchMode("idle");
    assert.equal(m.prefetchMode.value, "idle");
    assert.deepEqual(values, { "ac:outlines-ahead": "idle" });
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: an unknown value or a storage that throws gives the default", async () => {
  g.localStorage = keeping({ "ac:outlines-ahead": "toujours" });
  try {
    assert.equal((await load(true)).prefetchMode.value, "idle");
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
    assert.equal(m.prefetchMode.value, "idle");
    m.setPrefetchMode("off"); // lasts for this page
    assert.equal(m.prefetchMode.value, "off");
  } finally {
    delete g.localStorage;
  }
});
