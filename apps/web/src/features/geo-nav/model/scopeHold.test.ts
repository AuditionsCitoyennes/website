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
  // Nothing selected yet: nothing held, whatever the views.
  assert.equal(hold.id(), null);
  assert.equal(hold.of(fr), null);
  hold.view("FR", false, true);
  hold.derived("FR");
  assert.equal(hold.of(fr), null);
  // A tap on France: its flight lands, the landing reads France.
  hold.view("FR", true, false);
  assert.equal(hold.of(fr), fr); // held while that first view is read
  hold.derived("FR");
  assert.equal(hold.of(fr), fr);
  assert.equal(hold.of({ id: "FR" })?.id, "FR"); // the same unit of a newer tree
  // The view took the scope to Portugal: not the held zone, nothing held.
  hold.view("FR", false, true);
  hold.derived("PT");
  assert.equal(hold.id(), "FR");
  assert.equal(hold.of(pt), null);
  // Back on France: held again.
  hold.view("PT", false, true);
  hold.derived("FR");
  assert.equal(hold.of(fr), fr);
  // Another command replaces it.
  hold.view("PT", true, false);
  hold.derived("PT");
  assert.equal(hold.id(), "PT");
  assert.equal(hold.of(fr), null);
  assert.equal(hold.of(pt), pt);
});

test("the held zone is the scope the landing reads: the boot's frame, a unit the fit corrects", async () => {
  const m = await load(false);
  const hold = m.createScopeHold();
  // The boot: the command is sent with the world as the scope, and lands on France.
  hold.view("world", true, false);
  assert.equal(hold.id(), "world");
  hold.derived("FR");
  assert.equal(hold.id(), "FR");
  // Taken once: what later views read is not held.
  hold.derived("PT");
  assert.equal(hold.id(), "FR");
  // A landing whose view could not be read yet (another layout, a lieu being
  // read) is taken by the next view read, unless the user moved meanwhile.
  hold.view("FR", true, false);
  hold.view("FR", false, false);
  hold.derived("fr:reg:84");
  assert.equal(hold.id(), "fr:reg:84");
  hold.view("fr:reg:84", true, false);
  hold.view("fr:reg:84", false, true);
  hold.derived("FR");
  assert.equal(hold.id(), "fr:reg:84");
});

test("a flight the user took over: the command's unit stays held, not what the view reads", async () => {
  const m = await load(false);
  const hold = m.createScopeHold();
  // A tap on the Rhône, the finger on the map before the flight has landed.
  hold.view("fr:dep:69", true, true);
  assert.equal(hold.of({ id: "fr:dep:69" })?.id, "fr:dep:69");
  hold.derived("fr:reg:84"); // the view, short of the Rhône, read the région
  assert.equal(hold.id(), "fr:dep:69");
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
