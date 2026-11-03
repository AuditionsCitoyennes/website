// The credit's fold (creditFold.ts) against a fake map, fake boxes and fake
// timers, run with `node --import tsx --test` (root "test:scripts"). Pure: no
// map, no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { creditFold, FOLD_MS, FOLD_ON, SHOW, type CreditBox, type FoldMap } from "./creditFold";

type Ev = { originalEvent?: { deltaY?: number } | null };
type Fn = (e: Ev) => void;

/** Mapbox's part the fold uses: `on`/`off`, and a way to fire. */
class FakeMap implements FoldMap {
  listeners = new Map<string, Set<Fn>>();
  on(type: string, fn: Fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  off(type: string, fn: Fn) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, e: Ev = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
  }
  count(type?: string) {
    if (type) return this.listeners.get(type)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

/** A compact control: its class list, the button's attributes and click
 *  listeners. `toggle` is mapbox's own click handler, registered first. */
class FakeBox implements CreditBox {
  classes = new Set(["mapboxgl-ctrl", "mapboxgl-ctrl-attrib", "mapboxgl-compact"]);
  attrs = new Map<string, string>();
  clicks = new Set<() => void>();
  writes = 0;
  container = {
    classList: {
      add: (c: string) => {
        this.writes++;
        this.classes.add(c);
      },
      remove: (c: string) => {
        this.writes++;
        this.classes.delete(c);
      },
    },
  };
  button = {
    setAttribute: (n: string, v: string) => {
      this.writes++;
      this.attrs.set(n, v);
    },
    addEventListener: (_t: "click", fn: () => void) => void this.clicks.add(fn),
    removeEventListener: (_t: "click", fn: () => void) => void this.clicks.delete(fn),
  };
  /** Mapbox's _toggleAttribution, as the visitor's click runs it. */
  toggle() {
    const show = !this.classes.has(SHOW);
    if (show) this.classes.add(SHOW);
    else this.classes.delete(SHOW);
    this.attrs.set("aria-expanded", String(show));
  }
  /** The visitor's click: mapbox's handler first (bound at onAdd), then ours. */
  click() {
    this.toggle();
    for (const fn of [...this.clicks]) fn();
  }
  get open() {
    return this.classes.has(SHOW);
  }
}

class FakeTimers {
  pending = new Map<number, { fn: () => void; ms: number }>();
  made: { fn: () => void; ms: number }[] = [];
  cleared: unknown[] = [];
  next = 1;
  set = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    this.made.push({ fn, ms });
    return id;
  };
  clear = (id: unknown) => {
    this.cleared.push(id);
    this.pending.delete(id as number);
  };
  fireAll() {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const t of due) t.fn();
  }
}

function setup(box: FakeBox | null = new FakeBox()) {
  const map = new FakeMap();
  const timers = new FakeTimers();
  let current = box;
  const fold = creditFold(map, () => current, timers);
  return { map, timers, fold, box, setBox: (b: FakeBox | null) => (current = b) };
}

const USER = { originalEvent: { deltaY: 0 } };

test("arm opens the control, listens to the six starts and sets one 5 s timer", () => {
  const { map, timers, fold, box } = setup();
  fold.arm();
  assert.equal(fold.state(), "open");
  assert.ok(box!.open);
  assert.equal(box!.attrs.get("aria-expanded"), "true");
  for (const t of FOLD_ON) assert.equal(map.count(t), 1, t);
  assert.equal(map.count("wheel"), 1);
  assert.equal(map.count("boxzoomstart"), 1);
  assert.equal(map.count(), 6);
  assert.equal(box!.clicks.size, 1);
  assert.equal(timers.made.length, 1);
  assert.equal(timers.made[0].ms, FOLD_MS);
  assert.equal(FOLD_MS, 5000);
  assert.equal(timers.made[0].fn.name, "foldOnTimer");
});

test("the timer folds it: mapbox's closed state, every listener gone", () => {
  const { map, timers, fold, box } = setup();
  fold.arm();
  timers.fireAll();
  assert.ok(!box!.open);
  assert.equal(box!.attrs.get("aria-expanded"), "false");
  assert.equal(map.count(), 0);
  assert.equal(box!.clicks.size, 0);
  assert.equal(fold.state(), "done");
});

test("a user start (with a DOM event) folds it and clears the timer", () => {
  for (const type of FOLD_ON) {
    const { map, timers, fold, box } = setup();
    fold.arm();
    map.fire(type, USER);
    assert.ok(!box!.open, type);
    assert.equal(box!.attrs.get("aria-expanded"), "false", type);
    assert.equal(timers.pending.size, 0, type);
    assert.deepEqual(timers.cleared, [1], type);
    assert.equal(map.count(), 0, type);
    assert.equal(fold.state(), "done", type);
  }
});

test("a start without a DOM event (a camera command, the intro tilt) leaves it open", () => {
  for (const type of FOLD_ON) {
    for (const e of [{}, { originalEvent: null }, { originalEvent: undefined }]) {
      const { map, fold, box } = setup();
      fold.arm();
      const writes = box!.writes;
      map.fire(type, e);
      assert.ok(box!.open, type);
      assert.equal(box!.writes, writes, type);
      assert.equal(fold.state(), "open", type);
    }
  }
});

test("a wheel folds it only with a non-zero deltaY; a box zoom folds it", () => {
  const { map, fold, box } = setup();
  fold.arm();
  map.fire("wheel", { originalEvent: { deltaY: 0 } });
  assert.ok(box!.open);
  map.fire("wheel", { originalEvent: { deltaY: -3 } });
  assert.ok(!box!.open);
  assert.equal(fold.state(), "done");

  const b = setup();
  b.fold.arm();
  b.map.fire("boxzoomstart", {});
  assert.ok(!b.box!.open);
  assert.equal(b.box!.attrs.get("aria-expanded"), "false");
  assert.equal(b.map.count(), 0);
});

test("after the fold nothing writes again: events and the stale timer callback", () => {
  const { map, timers, fold, box } = setup();
  fold.arm();
  map.fire("dragstart", USER);
  const writes = box!.writes;
  for (const t of FOLD_ON) map.fire(t, USER);
  map.fire("wheel", { originalEvent: { deltaY: 5 } });
  map.fire("boxzoomstart", {});
  timers.made[0].fn(); // a timer that fired anyway
  fold.fold();
  fold.replaced();
  assert.equal(box!.writes, writes);
});

test("arm twice opens once with one timer; arm after done writes nothing", () => {
  const { timers, fold, box } = setup();
  fold.arm();
  const writes = box!.writes;
  fold.arm();
  assert.equal(box!.writes, writes);
  assert.equal(timers.made.length, 1);
  assert.equal(box!.clicks.size, 1);
  timers.fireAll();
  const after = box!.writes;
  fold.arm();
  assert.equal(box!.writes, after);
  assert.equal(timers.made.length, 1);
});

test("no compact control at arm: done, nothing registered or written", () => {
  const { map, timers, fold } = setup(null);
  fold.arm();
  assert.equal(fold.state(), "done");
  assert.equal(map.count(), 0);
  assert.equal(timers.made.length, 0);
});

test("the visitor's click while open is a dismiss: mapbox closes it, the fold ends", () => {
  const { map, timers, fold, box } = setup();
  fold.arm();
  box!.click();
  assert.ok(!box!.open); // by mapbox's toggle
  assert.equal(fold.state(), "done");
  assert.equal(box!.clicks.size, 0);
  assert.equal(map.count(), 0);
  assert.deepEqual(timers.cleared, [1]);
  const writes = box!.writes;
  timers.made[0].fn();
  map.fire("dragstart", USER);
  assert.equal(box!.writes, writes);
  // …and its clicks keep working.
  box!.click();
  assert.ok(box!.open);
  assert.equal(box!.writes, writes);
});

test("replaced while open opens the new control; the old one is left alone", () => {
  const { map, timers, fold, box, setBox } = setup();
  fold.arm();
  const old = box!;
  const next = new FakeBox();
  setBox(next);
  const oldWrites = old.writes;
  fold.replaced();
  assert.ok(next.open);
  assert.equal(next.attrs.get("aria-expanded"), "true");
  assert.equal(next.clicks.size, 1);
  assert.equal(old.clicks.size, 0);
  assert.equal(map.count(), 6); // the map's listeners and timer are unchanged
  assert.equal(timers.made.length, 1);
  map.fire("zoomstart", USER);
  assert.equal(old.writes, oldWrites);
  assert.ok(!next.open);
  assert.equal(next.attrs.get("aria-expanded"), "false");

  // Ten re-creations leave at most one click listener of ours in all.
  const r = setup();
  r.fold.arm();
  const boxes = [r.box!];
  for (let i = 0; i < 10; i++) {
    const b = new FakeBox();
    boxes.push(b);
    r.setBox(b);
    r.fold.replaced();
  }
  assert.equal(
    boxes.reduce((n, b) => n + b.clicks.size, 0),
    1,
  );
  assert.equal(r.timers.made.length, 1);
});

test("replaced in idle or done writes nothing; open with no new box ends", () => {
  const idle = setup();
  const b1 = new FakeBox();
  idle.setBox(b1);
  idle.fold.replaced();
  assert.equal(b1.writes, 0);
  assert.equal(idle.fold.state(), "idle");

  const done = setup();
  done.fold.arm();
  done.timers.fireAll();
  const b2 = new FakeBox();
  done.setBox(b2);
  done.fold.replaced();
  assert.equal(b2.writes, 0);

  const gone = setup();
  gone.fold.arm();
  const old = gone.box!;
  const writes = old.writes;
  gone.setBox(null);
  gone.fold.replaced();
  assert.equal(gone.fold.state(), "done");
  assert.equal(old.writes, writes);
  assert.equal(old.clicks.size, 0);
  assert.equal(gone.map.count(), 0);
  assert.equal(gone.timers.pending.size, 0);
});

test("dispose while open stops listening and writes nothing; in idle, a later arm is a no-op", () => {
  const { map, timers, fold, box } = setup();
  fold.arm();
  const writes = box!.writes;
  fold.dispose();
  assert.equal(map.count(), 0);
  assert.equal(box!.clicks.size, 0);
  assert.equal(timers.pending.size, 0);
  assert.equal(box!.writes, writes);
  assert.equal(fold.state(), "done");

  const idle = setup();
  idle.fold.dispose();
  idle.fold.arm();
  assert.equal(idle.box!.writes, 0);
  assert.equal(idle.timers.made.length, 0);
});

test("fold() now: closes an open control; nothing in idle (a later arm opens) or done", () => {
  const { map, timers, fold, box } = setup();
  fold.arm();
  fold.fold();
  assert.ok(!box!.open);
  assert.equal(box!.attrs.get("aria-expanded"), "false");
  assert.equal(map.count(), 0);
  assert.equal(timers.pending.size, 0);
  assert.equal(fold.state(), "done");
  const writes = box!.writes;
  fold.fold();
  assert.equal(box!.writes, writes);

  const idle = setup();
  idle.fold.fold();
  assert.equal(idle.box!.writes, 0);
  assert.equal(idle.fold.state(), "idle");
  idle.fold.arm();
  assert.ok(idle.box!.open);
});
