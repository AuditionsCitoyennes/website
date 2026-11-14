// The page's retry schedule (retrySchedule.ts), run with
// `node --import tsx --test` (root "test:scripts"): one timer per failure, the
// waits in turn, nothing past them but now(), the schedule over after "ok",
// no attempt on a page no longer failed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { retrySchedule } from "./retrySchedule";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const { recoverDelay } = await import("./recoverSwitch");

function setup() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  let retries = 0;
  const s = retrySchedule({
    retry: () => retries++,
    delay: recoverDelay,
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimer: (t) => void timers.delete(t as number),
  });
  /** Fires the one timer armed; its wait. */
  const fire = () => {
    assert.equal(timers.size, 1, "one timer armed");
    const [[id, t]] = [...timers];
    timers.delete(id);
    t.fn();
    return t.ms;
  };
  return { s, timers, fire, retries: () => retries };
}

test("a failure waits 2 s, then 5, 10, 20, 30 s between attempts, then only now()", () => {
  const t = setup();
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    t.s.update("failed");
    t.s.update("failed"); // told twice: still one timer
    waits.push(t.fire());
    assert.equal(t.retries(), i + 1);
    t.s.update("busy"); // the attempt on its way
    assert.equal(t.timers.size, 0);
  }
  assert.deepEqual(waits, [2000, 5000, 10_000, 20_000, 30_000]);
  t.s.update("failed");
  assert.equal(t.timers.size, 0, "past the schedule: no timer");
  t.s.now();
  assert.equal(t.retries(), 6, "now() tries at once");
  t.s.update("failed");
  assert.equal(t.fire(), 2000, "the schedule from its start");
});

test("a page that recovered starts the schedule over; a timer on a page no longer failed tries nothing", () => {
  const t = setup();
  t.s.update("failed");
  t.fire();
  t.s.update("ok");
  t.s.update("failed");
  assert.equal(t.fire(), 2000);
  assert.equal(t.retries(), 2);
  // The state changes under a timer it cannot see (none: "busy" clears it).
  t.s.update("failed");
  t.s.update("ok");
  assert.equal(t.timers.size, 0);
  assert.equal(t.retries(), 2);
});

test("now() on a page not failed does nothing; stop() clears the timer", () => {
  const t = setup();
  t.s.now();
  t.s.update("busy");
  t.s.now();
  assert.equal(t.retries(), 0);
  t.s.update("failed");
  t.s.stop();
  assert.equal(t.timers.size, 0);
});
