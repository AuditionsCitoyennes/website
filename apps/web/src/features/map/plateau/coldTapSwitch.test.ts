// The cold tap's three switches (coldTapSwitch.ts), run with `node --import
// tsx --test` (root "test:scripts"): the wait a plateau gets under each value
// of ac:outline-wait; a build without the testing tools never reads its
// storage (a counting stub holding other values) and keeps the defaults; with
// the testing tools a kept key keeps its mode, an unknown value or a storage
// that throws gives the default. The module is imported after the stubs (its
// modes are read at load), under a fresh query each time, as
// lateFilesSwitch.test.ts.

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
  return (await import(`./coldTapSwitch.ts?mode=${++n}`)) as typeof import("./coldTapSwitch");
}

test("the wait: the switch's with a coarse shape in memory, the full one without", async () => {
  const m = await load(false);
  assert.equal(m.outlineWaitFor("1200", true, 1200), 1200);
  assert.equal(m.outlineWaitFor("400", true, 1200), 400);
  assert.equal(m.outlineWaitFor("0", true, 1200), 0);
  for (const wait of m.OUTLINE_WAITS) assert.equal(m.outlineWaitFor(wait, false, 1200), 1200);
});

test("without the testing tools: the defaults, storage unread, the setters ignored", async () => {
  const values = { "ac:outline-wait": "0", "ac:region-self": "bundle", "ac:cold-start": "early" };
  g.localStorage = keeping(values);
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.outlineWait.value, m.DEFAULT_OUTLINE_WAIT);
    assert.equal(m.regionSelfMode.value, m.DEFAULT_REGION_SELF);
    assert.equal(m.coldStartMode.value, m.DEFAULT_COLD_START);
    m.setOutlineWait("400");
    m.setRegionSelfMode("bundle");
    m.setColdStartMode("early");
    assert.equal(m.outlineWait.value, m.DEFAULT_OUTLINE_WAIT);
    assert.equal(m.regionSelfMode.value, m.DEFAULT_REGION_SELF);
    assert.equal(m.coldStartMode.value, m.DEFAULT_COLD_START);
    assert.equal(values["ac:outline-wait"], "0");
  } finally {
    delete g.localStorage;
  }
});

test("the defaults: today's wait, today's hold, the self first; each one of its choices", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_OUTLINE_WAIT, "1200");
  assert.equal(m.DEFAULT_COLD_START, "hold");
  assert.equal(m.DEFAULT_REGION_SELF, "first");
  assert.deepEqual([...m.OUTLINE_WAITS], ["1200", "400", "0"]);
  assert.deepEqual([...m.REGION_SELF_MODES], ["first", "bundle"]);
  assert.deepEqual([...m.COLD_START_MODES], ["hold", "early"]);
  assert.ok(m.SELF_GRACE_MS > 0 && m.SELF_GRACE_MS <= 100);
});

test("with the testing tools: a kept key keeps its mode, and a setter keeps the new one", async () => {
  const values: Record<string, string> = {
    "ac:outline-wait": "0",
    "ac:region-self": "bundle",
    "ac:cold-start": "early",
  };
  g.localStorage = keeping(values);
  try {
    const m = await load(true);
    assert.equal(m.outlineWait.value, "0");
    assert.equal(m.regionSelfMode.value, "bundle");
    assert.equal(m.coldStartMode.value, "early");
    m.setOutlineWait("400");
    m.setRegionSelfMode("first");
    m.setColdStartMode("hold");
    assert.equal(m.outlineWait.value, "400");
    assert.deepEqual(values, {
      "ac:outline-wait": "400",
      "ac:region-self": "first",
      "ac:cold-start": "hold",
    });
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: an unknown value or a storage that throws gives the default", async () => {
  g.localStorage = keeping({
    "ac:outline-wait": "250",
    "ac:region-self": "",
    "ac:cold-start": "x",
  });
  try {
    const m = await load(true);
    assert.equal(m.outlineWait.value, m.DEFAULT_OUTLINE_WAIT);
    assert.equal(m.regionSelfMode.value, m.DEFAULT_REGION_SELF);
    assert.equal(m.coldStartMode.value, m.DEFAULT_COLD_START);
  } finally {
    delete g.localStorage;
  }
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    const m = await load(true);
    assert.equal(m.outlineWait.value, m.DEFAULT_OUTLINE_WAIT);
    assert.equal(m.regionSelfMode.value, m.DEFAULT_REGION_SELF);
    assert.equal(m.coldStartMode.value, m.DEFAULT_COLD_START);
  } finally {
    delete g.localStorage;
  }
});
