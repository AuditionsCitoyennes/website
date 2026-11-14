// The hold's switch and its state (scopeHold.ts), run with `node --import tsx
// --test` (root "test:scripts"): which devices keep the selected zone under
// each value of ac:scope-drag; which zone is held; a build without the
// testing tools never reads its storage (a counting stub holding another
// value) and keeps the default; with the testing tools a kept key keeps its
// mode, an unknown value or a storage that throws gives the default. The
// module is imported after the stubs (its mode is read at load), under a
// fresh query each time, as coldTapSwitch.test.ts.

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
  return (await import(`./scopeHold.ts?mode=${++n}`)) as typeof import("./scopeHold");
}

test("auto keeps the zone on a touch device and follows on a mouse device", async () => {
  const m = await load(false);
  assert.equal(m.dragKeepsZone("auto", true), true);
  assert.equal(m.dragKeepsZone("auto", false), false);
  assert.equal(m.dragKeepsZone("keep", true), true);
  assert.equal(m.dragKeepsZone("keep", false), true);
  assert.equal(m.dragKeepsZone("follow", true), false);
  assert.equal(m.dragKeepsZone("follow", false), false);
});

test("the default is auto, first of its three choices", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_SCOPE_DRAG, "auto");
  assert.deepEqual([...m.SCOPE_DRAG_MODES], ["auto", "keep", "follow"]);
});

test("the held zone: the scope a command landed on, held while it is the scope", async () => {
  const m = await load(false);
  const hold = m.createScopeHold();
  const fr = { id: "FR" };
  const pt = { id: "PT" };
  // Nothing selected yet: nothing held.
  assert.equal(hold.id(), null);
  assert.equal(hold.of(fr), null);
  // A command landed with France the scope: France is held, as the object given.
  hold.landed("FR");
  assert.equal(hold.of(fr), fr);
  assert.equal(hold.of({ id: "FR" })?.id, "FR"); // the same unit of a newer tree
  // The view took the scope to Portugal: not the held zone, nothing held.
  assert.equal(hold.of(pt), null);
  // Back on France: held again.
  assert.equal(hold.of(fr), fr);
  // Another command replaces it.
  hold.landed("PT");
  assert.equal(hold.id(), "PT");
  assert.equal(hold.of(fr), null);
  assert.equal(hold.of(pt), pt);
});

test("without the testing tools: the default, storage unread, the setter ignored", async () => {
  const values = { "ac:scope-drag": "follow" };
  g.localStorage = keeping(values);
  reads = 0;
  try {
    const m = await load(false);
    assert.equal(reads, 0);
    assert.equal(m.scopeDragMode.value, m.DEFAULT_SCOPE_DRAG);
    m.setScopeDragMode("keep");
    assert.equal(m.scopeDragMode.value, m.DEFAULT_SCOPE_DRAG);
    assert.equal(values["ac:scope-drag"], "follow");
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: a kept key keeps its mode, and the setter keeps the new one", async () => {
  const values: Record<string, string> = { "ac:scope-drag": "follow" };
  g.localStorage = keeping(values);
  try {
    const m = await load(true);
    assert.equal(m.scopeDragMode.value, "follow");
    m.setScopeDragMode("keep");
    assert.equal(m.scopeDragMode.value, "keep");
    assert.deepEqual(values, { "ac:scope-drag": "keep" });
  } finally {
    delete g.localStorage;
  }
});

test("with the testing tools: an unknown value or a storage that throws gives the default", async () => {
  g.localStorage = keeping({ "ac:scope-drag": "garder" });
  try {
    assert.equal((await load(true)).scopeDragMode.value, "auto");
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
    assert.equal(m.scopeDragMode.value, "auto");
    m.setScopeDragMode("follow"); // lasts for this page
    assert.equal(m.scopeDragMode.value, "follow");
  } finally {
    delete g.localStorage;
  }
});
