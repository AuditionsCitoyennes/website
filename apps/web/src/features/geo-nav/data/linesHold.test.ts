// A tapped unit's wait for its bundle (linesHold.ts), on a fake clock that
// starts at a page's age. Run with `node --import tsx --test` (root
// "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLinesHold } from "./linesHold";

const AGE = 60_000;
const WAIT = 4000;

function setup() {
  let now = AGE;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settled = new Set<string>();
  const out: { id: string; at: number }[] = [];
  const hold = createLinesHold({
    setTimer: (fn, ms) => {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimer: (timer) => void timers.delete(timer as number),
    settled: (id) => settled.has(id),
    onOut: (id) => out.push({ id, at: now - AGE }),
  });
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { hold, settled, out, tick, timers };
}

test("a bundle in before the wait ends: nothing given up", () => {
  const t = setup();
  t.hold.hold("fr:reg:84", WAIT);
  t.tick(3000);
  t.settled.add("fr:reg:84");
  t.tick(2000);
  assert.deepEqual(t.out, []);
  assert.equal(t.hold.holding("fr:reg:84"), false);
});

test("a bundle that never lands: given up at the wait's end, to the millisecond, whatever else is on the link", () => {
  // No reading of the link at all: another unit's file in flight (what makes
  // the wait for a unit's own file go on once) cannot extend this one.
  const t = setup();
  t.hold.hold("fr:reg:84", WAIT);
  t.hold.hold("fr:reg:84", WAIT); // one wait per unit
  assert.equal(t.timers.size, 1);
  t.tick(3999);
  assert.deepEqual(t.out, []);
  t.tick(1);
  assert.deepEqual(t.out, [{ id: "fr:reg:84", at: 4000 }]);
  t.tick(20_000);
  assert.equal(t.out.length, 1); // and nothing later
  assert.equal(t.timers.size, 0);
});

test("a unit left and tapped again gets a whole wait, not what was left of the first", () => {
  const t = setup();
  t.hold.hold("fr:reg:84", WAIT);
  t.tick(500);
  t.hold.leave("fr:reg:84");
  assert.equal(t.timers.size, 0);
  t.tick(3000); // tapped again 3.5 s after the first tap
  t.hold.hold("fr:reg:84", WAIT);
  t.tick(3999);
  assert.deepEqual(t.out, []); // 7.5 s after the first tap: still waited for
  t.tick(1);
  assert.deepEqual(t.out, [{ id: "fr:reg:84", at: 7500 }]);
});

test("leaving a unit gives nothing up, and another unit's wait runs on", () => {
  const t = setup();
  t.hold.hold("fr:reg:84", WAIT);
  t.tick(1000);
  t.hold.hold("fr:reg:76", WAIT);
  t.hold.leave("fr:reg:84");
  t.hold.leave("fr:reg:84"); // twice: nothing
  t.tick(4000);
  assert.deepEqual(t.out, [{ id: "fr:reg:76", at: 5000 }]);
});

test("no wait: given up at once, with no timer — unless the bundle is in", () => {
  const t = setup();
  t.hold.hold("fr:reg:84", 0);
  assert.deepEqual(t.out, [{ id: "fr:reg:84", at: 0 }]);
  assert.equal(t.timers.size, 0);
  t.settled.add("fr:reg:76");
  t.hold.hold("fr:reg:76", 0);
  assert.equal(t.out.length, 1);
});
