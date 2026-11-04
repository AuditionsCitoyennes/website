// The plateau mesh's mode (meshSwitch.ts), run with `node --import tsx --test`
// (root "test:scripts"): a build without the testing tools reads no storage
// and takes the default, the default being the one the flip chose; with the
// testing tools, a storage that throws gives the default too. The module is
// imported after the stubs (its mode is read at load), under a fresh query
// each time, as reliefSwitch.budget.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./meshSwitch.ts?mode=${++n}`)) as typeof import("./meshSwitch");
}

test("meshMode: the default without the testing tools, and the default is worker", async () => {
  delete g.localStorage; // never read: a read would throw
  const m = await load(false);
  assert.equal(m.meshMode, m.DEFAULT_MESH_MODE);
  assert.ok(m.MESH_MODES.includes(m.DEFAULT_MESH_MODE));
  assert.equal(m.DEFAULT_MESH_MODE, "worker");
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
