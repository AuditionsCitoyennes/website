// The still-map scheduler (stillMap.ts), run with `node --import tsx --test`
// (root "test:scripts") against a fake map, fake pointer targets and a fake
// clock: a job waits for the camera, the plateau and the pointers; jobs run
// first in first out, one per turn, never two inside one gap; a cancelled job
// never runs; a timeout runs its job on a busy map; a job that throws does
// not stop the queue; a detached map drops its jobs and its listeners.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TURN_GAP_MS,
  createStillMap,
  type PointerTarget,
  type StillClock,
  type StillMapSource,
} from "./stillMap";

/** A clock whose timers fire when `advance` passes their time, in time order. */
function fakeClock() {
  let now = 0;
  let ids = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: StillClock = {
    now: () => now,
    setTimeout(fn, ms) {
      timers.set(++ids, { at: now + Math.max(0, ms), fn });
      return ids;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  }
  return { clock, advance, timers: () => timers.size, now: () => now };
}

type Listener = (e: { pointerId?: number; isPrimary?: boolean }) => void;
function fakeTarget() {
  const listeners = new Map<string, Set<Listener>>();
  const target: PointerTarget = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  return {
    target,
    fire(type: string, e: { pointerId?: number; isPrimary?: boolean } = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
    },
    count: () => [...listeners.values()].reduce((a, s) => a + s.size, 0),
  };
}

function fakeMap() {
  let moving = false;
  const listeners = new Map<string, Set<() => void>>();
  const fire = (type: string) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
  const canvas = fakeTarget();
  const map: StillMapSource = {
    isMoving: () => moving,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    off(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    getCanvasContainer: () => canvas.target,
  };
  return {
    map,
    canvas,
    moveStart() {
      moving = true;
      fire("movestart");
    },
    moveEnd() {
      moving = false;
      fire("moveend");
    },
    /** The event heard before `isMoving()` turns false. */
    moveEndEarly() {
      fire("moveend");
      moving = false;
    },
    listeners: () => [...listeners.values()].reduce((a, s) => a + s.size, 0),
  };
}

function setup() {
  const c = fakeClock();
  const errors: unknown[] = [];
  const s = createStillMap({ clock: c.clock, onError: (e) => errors.push(e) });
  const m = fakeMap();
  const win = fakeTarget();
  s.attach(m.map, { surface: m.canvas.target, release: win.target });
  const ran: string[] = [];
  const job = (name: string) => () => void ran.push(name);
  return { ...c, s, m, win, ran, job, errors };
}

test("a still map runs a job at the next turn, not in the caller's task", () => {
  const { s, ran, job, advance } = setup();
  advance(1000);
  s.whenStill(job("a"));
  assert.deepEqual(ran, []);
  assert.equal(s.pending(), 1);
  advance(0);
  assert.deepEqual(ran, ["a"]);
  assert.equal(s.pending(), 0);
});

test("without a map nothing moves: the job runs at the next turn", () => {
  const c = fakeClock();
  const s = createStillMap({ clock: c.clock });
  let ran = 0;
  s.whenStill(() => ran++);
  c.advance(0);
  assert.equal(ran, 1);
  assert.deepEqual(s.busy(), { camera: false, plateau: false, pointer: false });
});

test("jobs run first in first out, one per turn, a gap apart", () => {
  const { s, ran, job, advance } = setup();
  advance(1000);
  s.whenStill(job("a"));
  s.whenStill(job("b"));
  s.whenStill(job("c"));
  advance(0);
  assert.deepEqual(ran, ["a"]);
  advance(TURN_GAP_MS - 1);
  assert.deepEqual(ran, ["a"]);
  advance(1);
  assert.deepEqual(ran, ["a", "b"]);
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["a", "b", "c"]);
});

test("a job asked from inside a job waits for the next turn", () => {
  const { s, ran, job, advance } = setup();
  advance(1000);
  s.whenStill(() => {
    ran.push("a");
    s.whenStill(job("inner"));
  });
  s.whenStill(job("b"));
  advance(0);
  assert.deepEqual(ran, ["a"]);
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["a", "b"]);
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["a", "b", "inner"]);
});

test("a moving camera holds the jobs; they start a gap after it stops", () => {
  const { s, m, ran, job, advance } = setup();
  advance(1000);
  m.moveStart();
  assert.deepEqual(s.busy(), { camera: true, plateau: false, pointer: false });
  s.whenStill(job("a"));
  advance(5000);
  assert.deepEqual(ran, []);
  m.moveEnd();
  assert.equal(s.still(), true);
  advance(TURN_GAP_MS - 1);
  assert.deepEqual(ran, []);
  advance(1);
  assert.deepEqual(ran, ["a"]);
});

test("a moveend heard before isMoving() turns false still starts the jobs", () => {
  const { s, m, ran, job, advance } = setup();
  advance(1000);
  m.moveStart();
  s.whenStill(job("a"));
  m.moveEndEarly();
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["a"]);
});

test("a flight starting between two jobs holds the second", () => {
  const { s, m, ran, job, advance } = setup();
  advance(1000);
  s.whenStill(job("a"));
  s.whenStill(job("b"));
  advance(0);
  m.moveStart();
  advance(2000);
  assert.deepEqual(ran, ["a"]);
  m.moveEnd();
  // A second flight before the gap ends: still held.
  advance(TURN_GAP_MS - 10);
  m.moveStart();
  advance(500);
  m.moveEnd();
  advance(TURN_GAP_MS - 1);
  assert.deepEqual(ran, ["a"]);
  advance(1);
  assert.deepEqual(ran, ["a", "b"]);
});

test("a rising or sinking plateau holds the jobs", () => {
  const { s, ran, job, advance } = setup();
  advance(1000);
  s.plateauMotionBegin();
  s.plateauMotionBegin(); // idempotent
  assert.deepEqual(s.busy(), { camera: false, plateau: true, pointer: false });
  s.whenStill(job("a"));
  advance(3000);
  assert.deepEqual(ran, []);
  s.plateauMotionEnd();
  s.plateauMotionEnd();
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["a"]);
});

test("a hold keeps the jobs back until every hold is released, once each", () => {
  const { s, ran, job, advance } = setup();
  advance(1000);
  const one = s.hold();
  const two = s.hold();
  s.whenStill(job("a"));
  advance(500);
  one();
  one(); // a second release of the same hold counts for nothing
  advance(500);
  assert.deepEqual(ran, []);
  assert.equal(s.busy().plateau, true);
  two();
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["a"]);
  assert.equal(s.still(), true);
});

test("a pointer down on the map holds the jobs until it is released anywhere", () => {
  const { s, m, win, ran, job, advance } = setup();
  advance(1000);
  m.canvas.fire("pointerdown", { pointerId: 7, isPrimary: true });
  assert.deepEqual(s.busy(), { camera: false, plateau: false, pointer: true });
  s.whenStill(job("a"));
  advance(3000);
  assert.deepEqual(ran, []);
  // Another pointer's release is not this one's.
  win.fire("pointerup", { pointerId: 9 });
  advance(100);
  assert.deepEqual(ran, []);
  win.fire("pointerup", { pointerId: 7 });
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["a"]);
});

test("two fingers: still only once both are up; a cancel and a blur release too", () => {
  const { s, m, win, advance } = setup();
  advance(1000);
  m.canvas.fire("pointerdown", { pointerId: 1, isPrimary: true });
  m.canvas.fire("pointerdown", { pointerId: 2, isPrimary: false });
  win.fire("pointerup", { pointerId: 1 });
  assert.equal(s.busy().pointer, true);
  win.fire("pointercancel", { pointerId: 2 });
  assert.equal(s.busy().pointer, false);
  m.canvas.fire("pointerdown", { pointerId: 3, isPrimary: true });
  win.fire("blur");
  assert.equal(s.busy().pointer, false);
  // A pointer whose release was never heard is forgotten at the next first press.
  m.canvas.fire("pointerdown", { pointerId: 4, isPrimary: true });
  m.canvas.fire("pointerdown", { pointerId: 5, isPrimary: true });
  win.fire("pointerup", { pointerId: 5 });
  assert.equal(s.busy().pointer, false);
});

test("a cancelled job never runs, and the others keep their order", () => {
  const { s, ran, job, advance } = setup();
  advance(1000);
  s.whenStill(job("a"));
  const cancelB = s.whenStill(job("b"));
  s.whenStill(job("c"));
  cancelB();
  cancelB();
  assert.equal(s.pending(), 2);
  advance(1000);
  assert.deepEqual(ran, ["a", "c"]);
  // Cancelling after the run is a no-op.
  const cancelD = s.whenStill(job("d"));
  advance(1000);
  cancelD();
  assert.deepEqual(ran, ["a", "c", "d"]);
});

test("a timeout runs its job on a busy map, once, and leaves the others waiting", () => {
  const { s, m, ran, job, advance, timers } = setup();
  advance(1000);
  m.moveStart();
  s.whenStill(job("a"));
  s.whenStill(job("b"), { timeoutMs: 300 });
  advance(299);
  assert.deepEqual(ran, []);
  advance(1);
  assert.deepEqual(ran, ["b"]);
  advance(5000);
  assert.deepEqual(ran, ["b"]);
  m.moveEnd();
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["b", "a"]);
  assert.equal(timers(), 0);
});

test("a job run in its turn clears its timeout; a cancelled one too", () => {
  const { s, ran, job, advance, timers } = setup();
  advance(1000);
  s.whenStill(job("a"), { timeoutMs: 300 });
  const cancel = s.whenStill(job("b"), { timeoutMs: 300 });
  cancel();
  advance(0);
  assert.deepEqual(ran, ["a"]);
  assert.equal(timers(), 0);
  advance(1000);
  assert.deepEqual(ran, ["a"]);
});

test("a timeout never puts two jobs inside one gap", () => {
  const { s, ran, advance, now } = setup();
  advance(1000);
  const at: number[] = [];
  const timed = (name: string) => () => {
    ran.push(name);
    at.push(now());
  };
  // "a" runs at 1000 in its turn; "b" is due at 1010, inside a's gap.
  s.whenStill(timed("a"));
  s.whenStill(timed("b"), { timeoutMs: 10 });
  s.whenStill(timed("c"));
  advance(200);
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.ok(at[1] - at[0] >= TURN_GAP_MS, `b ${at[1] - at[0]} ms after a`);
  assert.ok(at[2] - at[1] >= TURN_GAP_MS, `c ${at[2] - at[1]} ms after b`);
  // Two timeouts due together on a busy map: a gap apart as well.
  const { s: s2, m: m2, advance: adv2, now: now2 } = setup();
  const at2: number[] = [];
  m2.moveStart();
  s2.whenStill(() => at2.push(now2()), { timeoutMs: 100 });
  s2.whenStill(() => at2.push(now2()), { timeoutMs: 100 });
  adv2(500);
  assert.equal(at2.length, 2);
  assert.ok(at2[1] - at2[0] >= TURN_GAP_MS);
});

test("a job that throws is reported and the queue goes on", () => {
  const { s, ran, job, advance, errors } = setup();
  advance(1000);
  const boom = new Error("boom");
  s.whenStill(() => {
    throw boom;
  });
  s.whenStill(job("b"));
  advance(TURN_GAP_MS);
  assert.deepEqual(errors, [boom]);
  assert.deepEqual(ran, ["b"]);
});

test("a detached map drops its jobs, its timers and its listeners", () => {
  const { s, m, win, ran, job, advance, timers } = setup();
  advance(1000);
  assert.equal(m.listeners(), 2);
  assert.equal(m.canvas.count(), 1);
  assert.equal(win.count(), 3);
  m.moveStart();
  s.plateauMotionBegin();
  m.canvas.fire("pointerdown", { pointerId: 1 });
  s.whenStill(job("a"));
  s.whenStill(job("b"), { timeoutMs: 100 });
  // Another map's unmount is not this one's.
  s.detach(fakeMap().map);
  assert.equal(s.pending(), 2);
  s.detach(m.map);
  assert.equal(s.pending(), 0);
  assert.equal(timers(), 0);
  assert.equal(m.listeners() + m.canvas.count() + win.count(), 0);
  assert.deepEqual(s.busy(), { camera: false, plateau: false, pointer: false });
  advance(5000);
  assert.deepEqual(ran, []);
  s.detach(); // twice is a no-op
});

test("attaching another map replaces the first, and the first's unmount changes nothing", () => {
  const { s, m, ran, job, advance } = setup();
  advance(1000);
  const second = fakeMap();
  const win2 = fakeTarget();
  s.attach(second.map, { surface: second.canvas.target, release: win2.target });
  assert.equal(m.listeners(), 0);
  assert.equal(second.listeners(), 2);
  s.detach(m.map);
  second.moveStart();
  s.whenStill(job("a"));
  m.moveEnd(); // the old map says nothing any more
  advance(1000);
  assert.deepEqual(ran, []);
  second.moveEnd();
  advance(TURN_GAP_MS);
  assert.deepEqual(ran, ["a"]);
});

test("the default targets are the map's canvas container (and no window under node)", () => {
  const c = fakeClock();
  const s = createStillMap({ clock: c.clock });
  const m = fakeMap();
  s.attach(m.map);
  assert.equal(m.canvas.count(), 1);
  m.canvas.fire("pointerdown", { pointerId: 1 });
  assert.equal(s.busy().pointer, true);
  s.detach();
  assert.equal(m.canvas.count(), 0);
});
