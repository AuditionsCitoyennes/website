// The late outline files' mode (lateFilesSwitch.ts), run with `node --import tsx --test`
// (root "test:scripts"): a build without the testing tools never reads its
// storage (a counting stub holding "direct") and takes the default, the default
// being the one the flip chose; with the testing tools, a kept key keeps its
// mode and a storage that throws gives the default. The module is imported
// after the stubs (its mode is read at load), under a fresh query each time,
// as reliefSwitch.budget.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };

let reads = 0;
const keeping = (stored: string) => ({
  getItem(k: string) {
    reads++;
    return k === "ac:late-files" ? stored : null;
  },
});

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./lateFilesSwitch.ts?mode=${++n}`)) as typeof import("./lateFilesSwitch");
}

test("lateFilesMode: the default without the testing tools, storage unread, and the default is quiet", async () => {
  g.localStorage = keeping("direct");
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.lateFilesMode, m.DEFAULT_LATE_FILES);
    assert.ok(m.LATE_FILES_MODES.includes(m.DEFAULT_LATE_FILES));
    assert.equal(m.DEFAULT_LATE_FILES, "quiet");
  } finally {
    delete g.localStorage;
  }
});

test("lateFilesMode: a kept key keeps its mode, with the testing tools", async () => {
  g.localStorage = keeping("direct");
  reads = 0;
  try {
    const m = await load(true);
    assert.equal(reads, 1);
    assert.equal(m.lateFilesMode, "direct");
  } finally {
    delete g.localStorage;
  }
});

test("lateFilesMode: a storage that throws gives the default, with the testing tools", async () => {
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    const m = await load(true);
    assert.equal(m.lateFilesMode, m.DEFAULT_LATE_FILES);
  } finally {
    delete g.localStorage;
  }
});
