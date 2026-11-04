// The plateau mesh's mode (meshSwitch.ts), run with `node --import tsx --test`
// (root "test:scripts"): a build without the testing tools never reads its
// storage (a counting stub holding "ancien") and takes the default, the default
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
    return k === "ac:mesh" ? stored : null;
  },
});

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./meshSwitch.ts?mode=${++n}`)) as typeof import("./meshSwitch");
}

test("meshMode: the default without the testing tools, storage unread, and the default is worker", async () => {
  g.localStorage = keeping("ancien");
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.meshMode, m.DEFAULT_MESH_MODE);
    assert.ok(m.MESH_MODES.includes(m.DEFAULT_MESH_MODE));
    assert.equal(m.DEFAULT_MESH_MODE, "worker");
  } finally {
    delete g.localStorage;
  }
});

test("meshMode: a kept key keeps its mode, with the testing tools", async () => {
  g.localStorage = keeping("ancien");
  reads = 0;
  try {
    const m = await load(true);
    assert.equal(reads, 1);
    assert.equal(m.meshMode, "ancien");
  } finally {
    delete g.localStorage;
  }
});

test("meshMode: a storage that throws gives the default, with the testing tools", async () => {
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    const m = await load(true);
    assert.equal(m.meshMode, m.DEFAULT_MESH_MODE);
  } finally {
    delete g.localStorage;
  }
});
