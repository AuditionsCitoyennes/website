// The DEM slots' lifecycle (demSlots.ts) against a fake map and mocked timers,
// run with `node --import tsx --test` (root "test:scripts"). Pure: no map, no
// Vue, no alias.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  createDemSlots,
  DROP_FLOOR_MS,
  repointDemSlot,
  type DemSlot,
  type DemSlotMap,
} from "./demSlots";

const A: DemSlot = "plateau-dem-a";
const B: DemSlot = "plateau-dem-b";

/** Mapbox's part the slots use: sources, the terrain, one-time `render` and
 *  `remove` listeners. */
class FakeMap implements DemSlotMap {
  sources = new Set<string>();
  terrain: { source?: string } | null = null;
  /** The terrain's source as the last rendered frame evaluated it. */
  evaluated: string | undefined;
  listeners: (() => void)[] = [];
  removeListeners: (() => void)[] = [];
  /** Who registered each listener: `owner` at the time of its `once`. */
  owners = new Map<() => void, string>();
  owner = "";
  repaints = 0;
  /** Who asked each repaint: `owner` at the time of the call. */
  repaintOwners: string[] = [];
  removed: string[] = [];
  /** Removals of the source the evaluated terrain still names. */
  staleRemovals = 0;
  throwOnRemove = false;
  /** map.remove() was called: its style is gone, getSource throws. */
  dead = false;
  once(type: "render" | "remove", l: () => void) {
    (type === "render" ? this.listeners : this.removeListeners).push(l);
    this.owners.set(l, this.owner);
  }
  /** The live listeners (either type) `owner` registered. */
  listenersOf(owner: string) {
    return [...this.listeners, ...this.removeListeners].filter((l) => this.owners.get(l) === owner)
      .length;
  }
  off(type: "render" | "remove", l: () => void) {
    if (type === "render") this.listeners = this.listeners.filter((x) => x !== l);
    else this.removeListeners = this.removeListeners.filter((x) => x !== l);
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
    if (this.evaluated === id) this.staleRemovals++;
  }
  getTerrain() {
    return this.terrain;
  }
  triggerRepaint() {
    this.repaints++;
    this.repaintOwners.push(this.owner);
  }
  /** A rendered frame: the style evaluated first, then the one-time listeners
   *  leave and run (mapbox's order). */
  render() {
    this.evaluated = this.terrain?.source;
    const ls = this.listeners;
    this.listeners = [];
    for (const l of ls) l();
  }
  /** map.remove(): its `remove` listeners run, then the map is dead. */
  removeMap() {
    const ls = this.removeListeners;
    this.removeListeners = [];
    for (const l of ls) l();
    this.dead = true;
  }
}

function setup(onDrop?: (id: DemSlot) => void) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const map = new FakeMap();
  const state: { map: FakeMap | null; src: DemSlot | null } = { map, src: A };
  const slots = createDemSlots({ getMap: () => state.map, terrainSrc: () => state.src, onDrop });
  /** usePlateau's swap: the spare slot added, the terrain moved onto it, the old one dropped. */
  const swap = () => {
    const old = state.src ?? A;
    const next = old === A ? B : A;
    slots.addDemSlot(map, next, {});
    state.src = next;
    map.terrain = { source: next };
    map.owner = "swap";
    slots.swapped(map, old);
    map.owner = "";
    slots.dropDemSourceSoon(map, old);
    return old;
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

test("the terrain moved off both slots (flat ground): the one it left is dropped, and the spare", (t) => {
  t.after(() => mock.timers.reset());
  const dropped: DemSlot[] = [];
  const { map, state, slots, swap } = setup((id) => dropped.push(id));
  swap(); // a (never added) → b
  map.render();
  // A run's prefetch stood the spare slot up, then the ground went flat: the
  // terrain is on a source that is neither slot.
  slots.addDemSlot(map, A, {});
  state.src = null;
  map.terrain = { source: "plateau-flat" };
  slots.swapped(map, B);
  slots.dropDemSourceSoon(map, B);
  slots.dropDemSourceSoon(map, A);
  // No frame since the swap: nothing leaves yet.
  mock.timers.tick(DROP_FLOOR_MS);
  assert.deepEqual(map.removed, []);
  map.render();
  mock.timers.tick(0);
  assert.deepEqual([...map.removed].sort(), [A, B]);
  assert.deepEqual([...dropped].sort(), [A, B]);
  assert.equal(map.staleRemovals, 0);
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
  const atMostOne = (when: string) => {
    for (const owner of ["swap", A, B])
      assert.ok(map.listenersOf(owner) <= 1, `${when}: ${owner} has ${map.listenersOf(owner)}`);
    assert.equal(map.listenersOf(""), 0, `${when}: a listener nobody owns`);
  };
  for (let i = 0; i < 10; i++) {
    const old = swap();
    atMostOne(`swap ${i}`);
    // The only floor timer left is `old`'s: what registers in this tick is its drop's.
    map.owner = old;
    mock.timers.tick(DROP_FLOOR_MS + 100); // no frame: each drop waits on one
    map.owner = "";
    atMostOne(`swap ${i} after the floor`);
  }
  map.render();
  mock.timers.tick(0);
  assert.equal(map.listeners.length, 0);
  assert.deepEqual([...map.sources], [state.src]);
});

test("abort ends every wait false, no timer, no listener", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  map.render();
  swap(); // b's drop pending, the swap's frame pending
  mock.timers.tick(DROP_FLOOR_MS); // the drop now waits on a frame
  swap(); // a's drop on its floor timer
  let waited: boolean | undefined;
  void slots.waitForFrame(map, A).then((v) => (waited = v));
  // b's own removal by addDemSlot (the third swap re-added it) came before.
  const removed = [...map.removed];
  slots.abort();
  await settle();
  assert.equal(waited, false);
  assert.equal(map.listeners.length, 0);
  assert.equal(map.removeListeners.length, 0);
  const repaints = map.repaints;
  mock.timers.tick(10_000);
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

test("the spare slot's wait: only for the slot the last swap left, ended by a rendered frame", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  map.render();
  swap(); // b → a, no frame yet
  assert.equal(slots.spareNeedsFrame(map, B), true);
  assert.equal(slots.spareNeedsFrame(map, A), false);

  let byFrame: boolean | undefined;
  const before = map.repaints;
  void slots.waitForFrame(map, B).then((v) => (byFrame = v));
  assert.equal(map.repaints, before + 1);
  map.render();
  await settle();
  assert.equal(byFrame, true);
  assert.equal(slots.spareNeedsFrame(map, B), false);
  mock.timers.tick(DROP_FLOOR_MS); // b's drop, its frame rendered
  assert.deepEqual(map.removed, [B]);
  assert.equal(map.listeners.length, 0);
  assert.equal(map.removeListeners.length, 0);
});

test("no cap: without a frame the wait never ends and asks no second repaint", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  map.render();
  swap(); // b → a, no frame yet; b's drop on its floor timer
  let waited: boolean | undefined;
  map.owner = "wait";
  void slots.waitForFrame(map, B).then((v) => (waited = v));
  map.owner = "";
  assert.deepEqual(map.repaintOwners, ["wait"]);
  mock.timers.tick(10_000);
  await settle();
  assert.equal(waited, undefined);
  // The wait's one repaint, and b's drop's own at its floor (no frame rendered).
  assert.equal(map.repaints, 2);
  assert.equal(map.repaintOwners.filter((o) => o === "wait").length, 1);
  assert.deepEqual(map.removed, []);
  assert.equal(map.listenersOf("wait"), 2, "one render and one remove listener");
  map.render();
  await settle();
  assert.equal(waited, true);
  assert.equal(map.listenersOf("wait"), 0);
});

test("a frame within 1 s ends the wait at that frame, as before", async (t) => {
  t.after(() => mock.timers.reset());
  for (const after of [999, 1]) {
    const { map, slots, swap } = setup();
    swap();
    map.render();
    swap();
    let waited: boolean | undefined;
    void slots.waitForFrame(map, B).then((v) => (waited = v));
    mock.timers.tick(after);
    await settle();
    assert.equal(waited, undefined, `${after} ms: not before the frame`);
    map.render();
    await settle();
    assert.equal(waited, true, `${after} ms: at the frame`);
    assert.equal(map.listeners.length, 0);
    assert.equal(map.removeListeners.length, 0);
    mock.timers.reset();
  }
});

test("the map's remove event ends a wait false, with no listener left", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  map.render();
  swap();
  let waited: boolean | undefined;
  map.owner = "wait";
  void slots.waitForFrame(map, B).then((v) => (waited = v));
  map.owner = "";
  map.removeMap();
  await settle();
  assert.equal(waited, false);
  assert.equal(map.listenersOf("wait"), 0);
  assert.deepEqual(map.removed, []);
});

test("re-adding the slot ends its waits false; the other slot's wait stays pending", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  map.render();
  swap();
  let onB: boolean | undefined;
  let onA: boolean | undefined;
  map.owner = "B";
  void slots.waitForFrame(map, B).then((v) => (onB = v));
  map.owner = "A";
  void slots.waitForFrame(map, A).then((v) => (onA = v));
  map.owner = "";
  slots.addDemSlot(map, B, {});
  await settle();
  assert.equal(onB, false);
  assert.equal(onA, undefined);
  assert.equal(map.listenersOf("B"), 0);
  assert.equal(map.listenersOf("A"), 2);
  map.render();
  await settle();
  assert.equal(onA, true);
  assert.equal(map.listenersOf("A"), 0);
});

test("concurrent waits: one frame ends them all true, in call order", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap();
  map.render();
  swap();
  const before = map.repaints;
  const order: string[] = [];
  for (const i of [1, 2, 3]) void slots.waitForFrame(map, B).then((v) => order.push(`${i} ${v}`));
  assert.equal(map.repaints, before + 3);
  map.render();
  await settle();
  assert.deepEqual(order, ["1 true", "2 true", "3 true"]);
  assert.equal(map.listeners.length, 0);
  assert.equal(map.removeListeners.length, 0);
});

test("a throw from once or triggerRepaint (a removed map) ends the wait false at once", async (t) => {
  t.after(() => mock.timers.reset());
  for (const what of ["once", "triggerRepaint"] as const) {
    const { map, slots, swap } = setup();
    swap();
    map.render();
    swap();
    const removedMap = new Error("Cannot read properties of undefined (reading 'style')");
    if (what === "once")
      map.once = (type, l) => {
        if (type === "remove") throw removedMap;
        FakeMap.prototype.once.call(map, type, l);
      };
    else
      map.triggerRepaint = () => {
        throw removedMap;
      };
    let waited: boolean | undefined;
    map.owner = "wait";
    void slots.waitForFrame(map, B).then((v) => (waited = v));
    map.owner = "";
    await settle();
    assert.equal(waited, false, what);
    assert.equal(map.listenersOf("wait"), 0, what);
    mock.timers.reset();
  }
});

test("#152's R3 in the fake map: the spare is removed after the frame, never stale", async (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap(); // a (never added) → b
  map.render(); // evaluated: b
  swap(); // b → a (Rhône), no frame yet: evaluated still b, b's drop scheduled
  assert.equal(slots.spareNeedsFrame(map, B), true); // Lyon's prefetch, 50 ms later
  let waited: boolean | undefined;
  void slots.waitForFrame(map, B).then((v) => (waited = v));
  mock.timers.tick(1_500); // no frame: neither the drop nor the caller removes b
  await settle();
  assert.equal(waited, undefined);
  assert.deepEqual(map.removed, []);
  map.render();
  await settle();
  assert.equal(waited, true);
  // The caller (usePlateau's prefetch) goes on: the spare slot replaced.
  // Before this PR the wait resolved at its 1 s cap and this same addDemSlot
  // removed b while the evaluated terrain still named it: 1 stale removal.
  slots.addDemSlot(map, B, {});
  mock.timers.tick(0); // b's old drop: a newer generation, a no-op
  mock.timers.tick(DROP_FLOOR_MS);
  assert.deepEqual(map.removed, [B]);
  assert.equal(map.staleRemovals, 0);
  assert.equal(map.listeners.length, 0);
  assert.equal(map.removeListeners.length, 0);
});

test("the spare slot's wait: none for the first swap's never-added slot", (t) => {
  t.after(() => mock.timers.reset());
  const { map, slots, swap } = setup();
  swap(); // a (never added) → b, no frame yet
  assert.equal(slots.spareNeedsFrame(map, A), false);
  assert.equal(slots.spareNeedsFrame(map, B), false);
});

test("onDrop hears each slot a drop removed, and only those", (t) => {
  t.after(() => mock.timers.reset());
  const dropped: DemSlot[] = [];
  const { map, state, swap } = setup((id) => dropped.push(id));
  swap(); // a (never added) → b
  swap(); // b → a
  map.render();
  mock.timers.tick(DROP_FLOOR_MS);
  assert.deepEqual(dropped, [B]);
  swap(); // a → b
  state.map = null; // unmounted before the floor: nothing removed, nothing heard
  map.render();
  mock.timers.tick(DROP_FLOOR_MS);
  assert.deepEqual(dropped, [B]);
});

test("repointDemSlot: new tiles on the same source, its maxzoom written first when given", () => {
  const calls: string[] = [];
  const src = {
    _options: { tiles: ["ac-dem://old/{z}/{x}/{y}"], maxzoom: 9 },
    setTiles(tiles: string[]) {
      calls.push(`setTiles ${tiles[0]} maxzoom ${this._options.maxzoom}`);
      this._options.tiles = tiles;
    },
  };
  const map = {
    getSource: (id: string) => (id === A ? src : undefined),
    addSource: () => calls.push("addSource"),
    removeSource: () => calls.push("removeSource"),
  } as unknown as DemSlotMap;
  repointDemSlot(map, A, "ac-dem://new/{z}/{x}/{y}", 11);
  repointDemSlot(map, A, "ac-dem://newer/{z}/{x}/{y}");
  repointDemSlot(map, B, "ac-dem://none/{z}/{x}/{y}"); // not a source: nothing
  assert.deepEqual(calls, [
    "setTiles ac-dem://new/{z}/{x}/{y} maxzoom 11",
    "setTiles ac-dem://newer/{z}/{x}/{y} maxzoom 11",
  ]);
});
