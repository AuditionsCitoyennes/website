// The decorative outlines' switch (outlinesDecorSwitch.ts): when the
// decorative batches may be asked in each mode, how their write is handed to
// the still-map scheduler (once, with its cap, and a backstop when the
// scheduler drops the job), and the kept mode read back from storage. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const {
  DECOR_APPLY_BACKSTOP_MS,
  DECOR_APPLY_MS,
  DECOR_CAP_MS,
  DECOR_PARALLEL,
  DEFAULT_OUTLINES_DECOR,
  OUTLINES_DECORS,
  decorOpen,
  outlinesDecor,
  stillApply,
  storedOutlinesDecor,
} = await import("./outlinesDecorSwitch");

/** A localStorage stand-in for one test, removed after it. */
function withStorage(storage: unknown, run: () => void) {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const before = g.localStorage;
  Object.defineProperty(g, "localStorage", { value: storage, configurable: true });
  try {
    run();
  } finally {
    if (had) Object.defineProperty(g, "localStorage", { value: before, configurable: true });
    else delete g.localStorage;
  }
}
const kept = (value: string | null) => ({
  getItem: (k: string) => (k === "ac:outlines-decor" ? value : null),
});

test("the default waits for the first plateau, and a build without the testing tools uses it", () => {
  assert.equal(DEFAULT_OUTLINES_DECOR, "after");
  assert.deepEqual([...OUTLINES_DECORS], ["after", "boot"]);
  assert.equal(outlinesDecor, DEFAULT_OUTLINES_DECOR);
  assert.ok(DECOR_CAP_MS > 0 && DECOR_PARALLEL >= 1);
  assert.ok(DECOR_APPLY_BACKSTOP_MS > DECOR_APPLY_MS);
});

test("« after » opens at the world's scope, once a plateau stood, or past the cap; « boot » always", () => {
  const at = (mode: "after" | "boot", level: string, plateauStood: boolean, capPassed: boolean) =>
    decorOpen({ mode, level, plateauStood, capPassed });
  assert.equal(at("after", "country", false, false), false);
  assert.equal(at("after", "country", true, false), true);
  assert.equal(at("after", "country", false, true), true);
  assert.equal(at("after", "world", false, false), true);
  assert.equal(at("boot", "country", false, false), true);
  assert.equal(at("boot", "world", false, false), true);
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

test("the kept mode is read back; anything else gives the default", () => {
  withStorage(kept("boot"), () => assert.equal(storedOutlinesDecor(), "boot"));
  withStorage(kept("after"), () => assert.equal(storedOutlinesDecor(), "after"));
  withStorage(kept(null), () => assert.equal(storedOutlinesDecor(), "after"));
  withStorage(kept("apres"), () => assert.equal(storedOutlinesDecor(), "after"));
  withStorage(
    {
      getItem() {
        throw new Error("blocked");
      },
    },
    () => assert.equal(storedOutlinesDecor(), "after"),
  );
});
