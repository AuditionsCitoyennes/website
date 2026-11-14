// A plateau's wait for its unit's own file (selfHold.ts), on a fake clock.
// Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { createSelfHold } from "./selfHold";

function setup() {
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const state = { stored: new Set<string>(), abandoned: false, done: 0 };
  const out: [string, boolean][] = [];
  const hold = createSelfHold({
    waitMs: 1200,
    extraMs: 1200,
    setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
    stored: (id) => state.stored.has(id),
    abandoned: () => state.abandoned,
    abandonedDone: () => state.done,
    onHeldOut: (id, session) => out.push([id, session]),
  });
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const at = timers.findIndex((t) => t.at <= end);
      if (at === -1) break;
      const [t] = timers.splice(at, 1);
      now = t.at;
      t.fn();
    }
    now = end;
  };
  return { hold, state, out, tick, timers };
}

test("a self in before the wait ends: nothing held out", () => {
  const t = setup();
  t.hold.hold("fr:reg:84");
  t.tick(1000);
  t.state.stored.add("fr:reg:84");
  t.tick(500);
  assert.deepEqual(t.out, []);
  assert.equal(t.hold.holding("fr:reg:84"), false);
});

test("a slow file alone on the link: held out for the session at the wait's end", () => {
  const t = setup();
  t.hold.hold("fr:reg:84");
  t.hold.hold("fr:reg:84"); // one wait per unit
  assert.equal(t.timers.length, 1);
  t.tick(1199);
  assert.deepEqual(t.out, []);
  t.tick(1);
  assert.deepEqual(t.out, [["fr:reg:84", true]]);
});

test("an abandoned file on the link at the start: the wait goes on once, and a self in by then holds nothing out", () => {
  const t = setup();
  t.state.abandoned = true;
  t.hold.hold("fr:reg:84");
  t.tick(1200);
  assert.deepEqual(t.out, []); // not held out at the cap: one more wait
  t.state.abandoned = false;
  t.state.stored.add("fr:reg:84");
  t.tick(1200);
  assert.deepEqual(t.out, []);
  assert.equal(t.hold.holding("fr:reg:84"), false);
});

test("a wait an abandoned file crossed and still missed: held out for this visit only, after one more wait", () => {
  const t = setup();
  t.hold.hold("fr:reg:84");
  t.tick(600);
  t.state.done++; // one landed in the middle of the wait
  t.tick(600);
  assert.deepEqual(t.out, []);
  t.tick(1199);
  assert.deepEqual(t.out, []);
  t.tick(1);
  assert.deepEqual(t.out, [["fr:reg:84", false]]); // bounded: twice the wait, never more
  // The next visit waits again, and alone on the link it is remembered.
  t.hold.hold("fr:reg:84");
  t.tick(1200);
  assert.deepEqual(t.out.at(-1), ["fr:reg:84", true]);
});

test("an abandoned file first seen at the wait's end counts too", () => {
  const t = setup();
  t.hold.hold("fr:reg:84");
  t.tick(1100);
  t.state.abandoned = true;
  t.tick(100);
  assert.deepEqual(t.out, []);
  t.tick(1200);
  assert.deepEqual(t.out, [["fr:reg:84", false]]);
});

test("a shorter wait (a coarse shape to rise on): held out at its end, for the session", () => {
  const t = setup();
  t.hold.hold("fr:reg:84", 400);
  t.tick(399);
  assert.deepEqual(t.out, []);
  t.tick(1);
  assert.deepEqual(t.out, [["fr:reg:84", true]]);
});

test("a shorter wait crossed by an abandoned file goes on by its own length, once", () => {
  const t = setup();
  t.state.abandoned = true;
  t.hold.hold("fr:reg:84", 400);
  t.tick(400);
  assert.deepEqual(t.out, []);
  t.tick(399);
  assert.deepEqual(t.out, []);
  t.tick(1);
  assert.deepEqual(t.out, [["fr:reg:84", false]]);
});

test("no wait: held out at once, with no timer, for this visit only", () => {
  const t = setup();
  t.hold.hold("fr:reg:84", 0);
  assert.deepEqual(t.out, [["fr:reg:84", false]]);
  assert.equal(t.timers.length, 0);
  assert.equal(t.hold.holding("fr:reg:84"), false);
  // Asked again (the next visit): again at once.
  t.hold.hold("fr:reg:84", 0);
  assert.equal(t.out.length, 2);
});

test("no wait, its self already stored: nothing held out", () => {
  const t = setup();
  t.state.stored.add("fr:reg:84");
  t.hold.hold("fr:reg:84", 0);
  assert.deepEqual(t.out, []);
});
