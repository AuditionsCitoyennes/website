// The decorative outlines' rules (outlinesDecorSwitch.ts): when the
// decorative batches may be asked, and how their write is handed to the
// still-map scheduler (once, with its cap, and a backstop when the scheduler
// drops the job). Run with `node --import tsx --test` (root "test:scripts").
// Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECOR_APPLY_BACKSTOP_MS,
  DECOR_APPLY_MS,
  DECOR_CAP_MS,
  DECOR_PARALLEL,
  decorOpen,
  stillApply,
} from "./outlinesDecorSwitch";

test("the constants: a cap, a few at a time, a backstop past the scheduler's cap", () => {
  assert.ok(DECOR_CAP_MS > 0 && DECOR_PARALLEL >= 1);
  assert.ok(DECOR_APPLY_BACKSTOP_MS > DECOR_APPLY_MS);
});

test("open at the world's scope, once a plateau stood, or past the cap", () => {
  const at = (level: string, plateauStood: boolean, capPassed: boolean) =>
    decorOpen({ level, plateauStood, capPassed });
  assert.equal(at("country", false, false), false);
  assert.equal(at("country", true, false), true);
  assert.equal(at("country", false, true), true);
  assert.equal(at("world", false, false), true);
});

/** A fake scheduler and clock: jobs and timers run when the test says. */
function fakes() {
  const jobs: { run: () => void; timeoutMs: number; cancelled: boolean }[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const writes: number[] = [];
  const apply = stillApply({
    whenStill: (run, opts) => {
      const job = { run, timeoutMs: opts.timeoutMs, cancelled: false };
      jobs.push(job);
      return () => void (job.cancelled = true);
    },
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimer: (id) => void timers.delete(id as number),
  });
  return { jobs, timers, writes, apply };
}

test("the write is handed to the still-map scheduler with its cap, and runs once", () => {
  const f = fakes();
  f.apply(() => f.writes.push(1));
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].timeoutMs, DECOR_APPLY_MS);
  assert.deepEqual(
    [...f.timers.values()].map((t) => t.ms),
    [DECOR_APPLY_BACKSTOP_MS],
  );
  assert.equal(f.writes.length, 0);
  f.jobs[0].run(); // the map is still
  assert.equal(f.writes.length, 1);
  assert.equal(f.timers.size, 0); // the backstop disarmed
  f.jobs[0].run();
  assert.equal(f.writes.length, 1);
});

test("a job the scheduler dropped (its map let go) is written by the backstop, once", () => {
  const f = fakes();
  f.apply(() => f.writes.push(1));
  const [backstop] = [...f.timers.values()];
  backstop.fn();
  assert.equal(f.writes.length, 1);
  assert.equal(f.jobs[0].cancelled, true); // the scheduler's job taken back
  f.jobs[0].run();
  assert.equal(f.writes.length, 1);
});
