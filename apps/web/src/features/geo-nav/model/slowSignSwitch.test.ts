// The long wait sign's switch (slowSignSwitch.ts), run with `node --import tsx
// --test` (root "test:scripts"): a build without the testing tools never
// reads its storage (a counting stub holding another value) and keeps the
// default; with the testing tools a kept key keeps its mode, the setter keeps
// the new one, and an unknown value or a storage that throws gives the
// default. The module is imported after the stubs (its mode is read at
// load), under a fresh query each time, as model/scopeHold.test.ts does.

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
  return (await import(`./slowSignSwitch.ts?mode=${++n}`)) as typeof import("./slowSignSwitch");
}

test("without the testing tools: the default (on), storage unread, the setter ignored", async () => {
  const values = { "ac:slow-sign": "off" };
  g.localStorage = keeping(values);
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.DEFAULT_SLOW_SIGN, "on");
    assert.ok(m.SLOW_SIGN_MODES.includes(m.DEFAULT_SLOW_SIGN));
    assert.equal(m.slowSignMode.value, m.DEFAULT_SLOW_SIGN);
    m.setSlowSignMode("off");
    assert.equal(m.slowSignMode.value, m.DEFAULT_SLOW_SIGN);
    assert.equal(values["ac:slow-sign"], "off");
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: a kept key keeps its mode, and the setter keeps the new one", async () => {
  const values: Record<string, string> = { "ac:slow-sign": "off" };
  g.localStorage = keeping(values);
  try {
    const m = await load(true);
    assert.equal(m.slowSignMode.value, "off");
    m.setSlowSignMode("on");
    assert.equal(m.slowSignMode.value, "on");
    assert.deepEqual(values, { "ac:slow-sign": "on" });
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: an unknown value or a storage that throws gives the default", async () => {
  g.localStorage = keeping({ "ac:slow-sign": "toujours" });
  try {
    assert.equal((await load(true)).slowSignMode.value, "on");
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
    assert.equal(m.slowSignMode.value, "on");
    m.setSlowSignMode("off"); // lasts for this page
    assert.equal(m.slowSignMode.value, "off");
  } finally {
    delete g.localStorage;
  }
});
