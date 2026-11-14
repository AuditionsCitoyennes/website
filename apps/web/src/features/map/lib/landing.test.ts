// The landing wait (landing.ts) against a fake map and a fake clock, run with
// `node --import tsx --test` (root "test:scripts"): a flight landing, a
// `moveend` that is not a landing, the cap, the cancellation, a map already
// at rest and a removed map; no listener and no timer left behind.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isFlying, whenLanded, type Landing, type LandingSource } from "./landing";

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn: () => void, ms: number) {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(id: unknown) {
      timers.delete(id as number);
    },
    /** Time passes: the timers due run, in order. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

function fakeMap(easing: boolean) {
  const listeners = new Set<() => void>();
  return {
    easing,
    isEasing() {
      return this.easing;
    },
    on(_type: "moveend", fn: () => void) {
      listeners.add(fn);
    },
    off(_type: "moveend", fn: () => void) {
      listeners.delete(fn);
    },
    moveend() {
      for (const fn of [...listeners]) fn();
    },
    listeners: () => listeners.size,
  };
}

/** The wait's outcome so far (null: still waiting), after the microtasks. */
async function outcome(done: Promise<Landing>): Promise<Landing | null> {
  let how: Landing | null = null;
  void done.then((h) => (how = h));
  await Promise.resolve();
  await Promise.resolve();
  return how;
}

test("isFlying: mapbox's easing, false for no map and for one that throws", () => {
  assert.equal(isFlying(fakeMap(true)), true);
  assert.equal(isFlying(fakeMap(false)), false);
  assert.equal(isFlying(null), false);
  assert.equal(isFlying(undefined), false);
  const removed = {
    isEasing() {
      throw new Error("removed");
    },
  } as unknown as LandingSource;
  assert.equal(isFlying(removed), false);
});

test("a flight lands: the wait ends at the moveend's check, nothing left behind", async () => {
  const clock = fakeClock();
  const map = fakeMap(true);
  const { done } = whenLanded(map, 3500, clock);
  assert.equal(map.listeners(), 1);
  clock.advance(500);
  assert.equal(await outcome(done), null);
  // The flight ends: mapbox fires moveend with the easing over.
  map.easing = false;
  map.moveend();
  // Not inside the event: one timer task later.
  assert.equal(await outcome(done), null);
  clock.advance(0);
  assert.equal(await outcome(done), "landed");
  assert.equal(map.listeners(), 0);
  assert.equal(clock.pending(), 0);
});

test("a moveend fired by the next flight's start is not a landing", async () => {
  const clock = fakeClock();
  const map = fakeMap(true);
  const { done } = whenLanded(map, 3500, clock);
  // A new command: mapbox ends the old flight (moveend, easing off for an
  // instant) and starts the new one in the same call.
  map.easing = false;
  map.moveend();
  map.easing = true;
  clock.advance(0);
  assert.equal(await outcome(done), null);
  assert.equal(map.listeners(), 1);
  // Two events in one task: one check.
  map.moveend();
  map.moveend();
  assert.equal(clock.pending(), 2); // the check and the cap
  clock.advance(0);
  assert.equal(await outcome(done), null);
  // The second flight lands.
  clock.advance(550);
  map.easing = false;
  map.moveend();
  clock.advance(0);
  assert.equal(await outcome(done), "landed");
  assert.equal(clock.pending(), 0);
});

test("the cap: a flight that does not land in time is not waited for", async () => {
  const clock = fakeClock();
  const map = fakeMap(true);
  const { done } = whenLanded(map, 3500, clock);
  clock.advance(3499);
  assert.equal(await outcome(done), null);
  clock.advance(1);
  assert.equal(await outcome(done), "cap");
  assert.equal(map.listeners(), 0);
  assert.equal(clock.pending(), 0);
  // A late moveend changes nothing.
  map.easing = false;
  map.moveend();
  clock.advance(10);
  assert.equal(await outcome(done), "cap");
});

test("cancel: the wait ends at once, once, with nothing left behind", async () => {
  const clock = fakeClock();
  const map = fakeMap(true);
  const { done, cancel } = whenLanded(map, 3500, clock);
  map.easing = false;
  map.moveend(); // a check is pending
  cancel();
  assert.equal(await outcome(done), "cancelled");
  assert.equal(map.listeners(), 0);
  assert.equal(clock.pending(), 0);
  cancel();
  clock.advance(5000);
  assert.equal(await outcome(done), "cancelled");
});

test("a map already at rest: landed one timer task later, never synchronously", async () => {
  const clock = fakeClock();
  const map = fakeMap(false);
  const { done } = whenLanded(map, 3500, clock);
  assert.equal(await outcome(done), null);
  clock.advance(0);
  assert.equal(await outcome(done), "landed");
  assert.equal(map.listeners(), 0);
  assert.equal(clock.pending(), 0);
});

test("a removed map: the wait is cancelled, and its cap dropped", async () => {
  const clock = fakeClock();
  const removed = {
    isEasing: () => true,
    on() {
      throw new Error("removed");
    },
    off() {
      throw new Error("removed");
    },
  } as unknown as LandingSource;
  const { done } = whenLanded(removed, 3500, clock);
  assert.equal(await outcome(done), "cancelled");
  assert.equal(clock.pending(), 0);
});
