// The DEM slots' lifecycle (demSlots.ts) against a fake map and mocked timers,
// run with `node --import tsx --test` (root "test:scripts"). Pure: no map, no
// Vue, no alias.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  createDemSlots,
  DROP_FLOOR_MS,
  SPARE_WAIT_CAP_MS,
  type DemSlot,
  type DemSlotMap,
} from "./demSlots";

const A: DemSlot = "plateau-dem-a";
const B: DemSlot = "plateau-dem-b";

/** Mapbox's part the slots use: sources, the terrain, one-time `render` listeners. */
class FakeMap implements DemSlotMap {
  sources = new Set<string>();
  terrain: { source?: string } | null = null;
  listeners: (() => void)[] = [];
  repaints = 0;
  removed: string[] = [];
  throwOnRemove = false;
  /** map.remove() was called: its style is gone, getSource throws. */
  dead = false;
  once(_type: "render", l: () => void) {
    this.listeners.push(l);
  }
  off(_type: "render", l: () => void) {
    this.listeners = this.listeners.filter((x) => x !== l);
  }
  getSource(id: string) {
    if (this.dead) throw new Error("Cannot read properties of undefined (reading 'getSource')");
    return this.sources.has(id) ? {} : undefined;
  }
  addSource(id: string) {
    if (this.sources.has(id)) throw new Error(`There is already a source with ID "${id}".`);
    this.sources.add(id);
  }
  removeSource(id: string) {
    if (this.throwOnRemove) throw new Error("Cannot read properties of undefined (reading 'get')");
    this.sources.delete(id);
    this.removed.push(id);
  }
  getTerrain() {
    return this.terrain;
  }
  triggerRepaint() {
    this.repaints++;
  }
  /** A rendered frame: the one-time listeners leave, then run (mapbox's order). */
  render() {
    const ls = this.listeners;
    this.listeners = [];
    for (const l of ls) l();
  }
}

function setup() {
  mock.timers.enable({ apis: ["setTimeout"] });
  const map = new FakeMap();
  const state: { map: FakeMap | null; src: DemSlot } = { map, src: A };
  const slots = createDemSlots({ getMap: () => state.map, terrainSrc: () => state.src });
  /** usePlateau's swap: the spare slot added, the terrain moved onto it, the old one dropped. */
  const swap = () => {
    const old = state.src;
    const next = old === A ? B : A;
    slots.addDemSlot(map, next, {});
    state.src = next;
    map.terrain = { source: next };
    slots.swapped(map, old);
    slots.dropDemSourceSoon(map, old);
  };
  return { map, state, slots, swap };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("the old slot leaves DROP_FLOOR_MS after a swap whose frame rendered", (t) => {
  t.after(() => mock.timers.reset());
  const { map, swap } = setup();
  swap(); // a (never added) → b
  swap(); // b → a
  map.render();
  mock.timers.tick(DROP_FLOOR_MS - 1);
  assert.deepEqual(map.removed, []);
  mock.timers.tick(1);
  assert.deepEqual(map.removed, [B]);
  assert.deepEqual([...map.sources], [A]);
  assert.equal(map.listeners.length, 0);
  assert.equal(map.repaints, 0);
});

test("the first swap's never-added slot schedules nothing", (t) => {
  t.after(() => mock.timers.reset());
  const { map, swap } = setup();
  swap();
  map.render();
  mock.timers.tick(10 * DROP_FLOOR_MS);
  assert.deepEqual(map.removed, []);
  assert.equal(map.listeners.length, 0);
});

test("a slot re-added since (a newer generation) is not dropped", (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  swap(); // b → a, b's drop pending
  map.render();
  // A superseded run's prefetch re-adds b as the spare (its hillshade on it).
  slots.addDemSlot(map, B, {});
  mock.timers.tick(DROP_FLOOR_MS);
  assert.deepEqual(map.removed, [B], "only addDemSlot's own synchronous removal");
  assert.ok(map.sources.has(B));
});

test("a slot the terrain is on is not dropped", (t) => {
  t.after(() => mock.timers.reset());
  {
    const { map, state, swap } = setup();
    swap();
    swap(); // b → a
    map.render();
    state.src = B; // terrainSrc moved back meanwhile
    mock.timers.tick(DROP_FLOOR_MS);
    assert.deepEqual(map.removed, []);
  }
  mock.timers.reset();
  {
    const { map, swap } = setup();
    swap();
    swap(); // b → a
    map.render();
    map.terrain = { source: B }; // the stylesheet still on b
    mock.timers.tick(DROP_FLOOR_MS);
    assert.deepEqual(map.removed, []);
  }
});

test("no map, or another map instance (a remount), drops nothing", (t) => {
  t.after(() => mock.timers.reset());
  {
    const { map, state, swap } = setup();
    swap();
    swap();
    map.render();
    state.map = null;
    mock.timers.tick(DROP_FLOOR_MS);
    assert.deepEqual(map.removed, []);
  }
  mock.timers.reset();
  {
    const { map, state, swap } = setup();
    swap();
    swap();
    map.render();
    const other = new FakeMap();
    other.sources.add(B);
    state.map = other;
    mock.timers.tick(DROP_FLOOR_MS);
    assert.deepEqual(map.removed, []);
    assert.deepEqual(other.removed, []);
  }
});

test("no frame since the swap: one repaint asked, the drop after that frame, out of its handler", (t) => {
  t.after(() => mock.timers.reset());
  const { map, swap } = setup();
  swap();
  map.render();
  swap(); // b → a, no frame after it
  mock.timers.tick(DROP_FLOOR_MS);
  assert.deepEqual(map.removed, []);
  assert.equal(map.repaints, 1);
  mock.timers.tick(10_000); // a hidden map: no cap, the slot stays
  assert.deepEqual(map.removed, []);
  assert.equal(map.repaints, 1);
  map.render();
  assert.deepEqual(map.removed, [], "never inside mapbox's render handler");
  mock.timers.tick(0);
  assert.deepEqual(map.removed, [B]);
  assert.equal(map.listeners.length, 0);
});

test("listeners stay at one for the swap and one per slot over 10 swaps", (t) => {
  t.after(() => mock.timers.reset());
  const { map, state, swap } = setup();
  for (let i = 0; i < 10; i++) {
    swap();
    assert.ok(map.listeners.length <= 3, `swap ${i}: ${map.listeners.length}`);
    mock.timers.tick(DROP_FLOOR_MS + 100); // no frame: each drop waits on one
    assert.ok(map.listeners.length <= 3, `swap ${i} after the floor: ${map.listeners.length}`);
  }
  map.render();
  mock.timers.tick(0);
  assert.equal(map.listeners.length, 0);
  assert.deepEqual([...map.sources], [state.src]);
});

test("abort leaves no timer, no listener, no pending wait", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  map.render();
  swap(); // b's drop pending, the swap's frame pending
  mock.timers.tick(DROP_FLOOR_MS); // the drop now waits on a frame
  swap(); // a's drop on its floor timer
  let waited = false;
  void slots.waitForFrame(map).then(() => (waited = true));
  // b's own removal by addDemSlot (the third swap re-added it) came before.
  const removed = [...map.removed];
  slots.abort();
  await settle();
  assert.equal(waited, true);
  assert.equal(map.listeners.length, 0);
  const repaints = map.repaints;
  mock.timers.tick(10 * SPARE_WAIT_CAP_MS);
  map.render();
  mock.timers.tick(0);
  assert.deepEqual(map.removed, removed);
  assert.equal(map.repaints, repaints);
});

test("a throw from removeSource, or from a removed map, is swallowed", (t) => {
  t.after(() => mock.timers.reset());
  {
    const { map, swap } = setup();
    swap();
    swap();
    map.render();
    map.throwOnRemove = true;
    assert.doesNotThrow(() => mock.timers.tick(DROP_FLOOR_MS));
    assert.ok(map.sources.has(B), "left resident");
    assert.equal(map.listeners.length, 0);
  }
  mock.timers.reset();
  {
    const { map, swap } = setup();
    swap();
    swap();
    map.render();
    map.dead = true;
    assert.doesNotThrow(() => mock.timers.tick(DROP_FLOOR_MS));
  }
});

test("the spare slot's wait: only for the slot the last swap left, ended by a frame or the cap", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  map.render();
  swap(); // b → a, no frame yet
  assert.equal(slots.spareNeedsFrame(B), true);
  assert.equal(slots.spareNeedsFrame(A), false);

  let byFrame = false;
  const before = map.repaints;
  void slots.waitForFrame(map).then(() => (byFrame = true));
  assert.equal(map.repaints, before + 1);
  map.render();
  await settle();
  assert.equal(byFrame, true);
  assert.equal(slots.spareNeedsFrame(B), false);
  mock.timers.tick(DROP_FLOOR_MS); // b's drop, its frame rendered
  assert.deepEqual(map.removed, [B]);

  let byCap = false;
  void slots.waitForFrame(map).then(() => (byCap = true));
  mock.timers.tick(SPARE_WAIT_CAP_MS - 1);
  await settle();
  assert.equal(byCap, false);
  mock.timers.tick(1);
  await settle();
  assert.equal(byCap, true);
  assert.equal(map.listeners.length, 0);
});
