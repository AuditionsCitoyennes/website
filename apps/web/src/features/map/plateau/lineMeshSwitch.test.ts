// The ac:line-mesh switch (lineMeshSwitch.ts) against a stubbed localStorage,
// run with `node --import tsx --test` (root "test:scripts"): the kept value,
// garbage and a throwing storage; the page's value with and without the
// testing tools (the module read again under a fresh query); a choice kept
// with a reload.

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
let reads = 0;
g.localStorage = {
  getItem(k: string) {
    reads++;
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
  return (await import(`./lineMeshSwitch.ts?load=${++n}`)) as typeof import("./lineMeshSwitch");
}

test("storedLineMesh: the kept value, else the default, which is lean", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_LINE_MESH, "lean");
  assert.deepEqual([...m.LINE_MESHES], ["lean", "full"]);
  for (const kept of m.LINE_MESHES) {
    stored = { "ac:line-mesh": kept };
    assert.equal(m.storedLineMesh(), kept);
  }
  for (const garbage of ["", "Lean", "FULL", " full", "off", "on", "worker"]) {
    stored = { "ac:line-mesh": garbage };
    assert.equal(m.storedLineMesh(), "lean", garbage);
  }
  stored = {};
  assert.equal(m.storedLineMesh(), "lean");
  throwing = true;
  assert.equal(m.storedLineMesh(), "lean");
  throwing = false;
});

test("lineMesh: the kept value with the testing tools; without them the default, storage unread", async () => {
  stored = { "ac:line-mesh": "full" };
  const tools = await load(true);
  assert.equal(tools.lineMesh, "full");
  assert.equal(tools.leanLines, false);
  reads = 0;
  const plain = await load(false);
  assert.equal(reads, 0);
  assert.equal(plain.lineMesh, "lean");
  assert.equal(plain.leanLines, true);
  stored = {};
  assert.equal((await load(true)).leanLines, true);
});

test("setLineMesh: another choice is kept and the page loaded again; the same one, or no testing tools, does nothing", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true);
  m.setLineMesh("lean");
  assert.deepEqual(stored, {});
  assert.equal(reloads, 0);
  m.setLineMesh("full");
  assert.deepEqual(stored, { "ac:line-mesh": "full" });
  assert.equal(reloads, 1);
  // A storage that refuses: the reload still happens (the choice is lost with it).
  throwing = true;
  m.setLineMesh("full");
  throwing = false;
  assert.equal(reloads, 2);
  stored = {};
  const plain = await load(false);
  plain.setLineMesh("full");
  assert.deepEqual(stored, {});
  assert.equal(reloads, 2);
});
