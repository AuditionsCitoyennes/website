// The idle prefetch (idlePrefetch.ts) with a scripted map: when it asks, what
// it asks and what stops it. Run with `node --import tsx --test` (root
// "test:scripts"). Pure: no Vue.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PREFETCH_UNITS,
  PREFETCH_UNITS_WEAK,
  idlePrefetch,
  pickPrefetch,
  prefetchAllowed,
  prefetchUnits,
  type PrefetchGuard,
} from "./idlePrefetch";

const flush = () => new Promise((r) => setImmediate(r));

function setup(targets: string[] = ["fr:reg:84", "fr:reg:11"]) {
  let allowed = true;
  const asked: string[] = [];
  const answers: (() => void)[] = [];
  /** The jobs waiting for a map at rest. */
  const waiting: (() => void)[] = [];
  let cancelled = 0;
  const scopes: string[] = [];
  const p = idlePrefetch({
    allowed: () => allowed,
    targets: (scopeId) => {
      scopes.push(scopeId);
      return [...targets];
    },
    prefetch: (id) => {
      asked.push(id);
      return new Promise<void>((done) => answers.push(done));
    },
    whenAtRest: (job) => {
      waiting.push(job);
      return () => {
        const at = waiting.indexOf(job);
        if (at === -1) return;
        waiting.splice(at, 1);
        cancelled++;
      };
    },
  });
  return {
    p,
    asked,
    scopes,
    waiting,
    cancelledCount: () => cancelled,
    forbid: () => (allowed = false),
    /** The map comes to rest: the job waiting runs. */
    rest: () => waiting.shift()?.(),
    /** The request under way settles. */
    answer: async () => {
      answers.shift()!();
      await flush();
    },
  };
}

test("nothing is asked before the first plateau stands, nor before the map is at rest", () => {
  const t = setup();
  t.rest();
  assert.deepEqual(t.asked, []);
  assert.equal(t.p.state(), "waiting");
  t.p.settled("", "cleared"); // the map cleared: no plateau
  t.p.settled("FR", "failed");
  assert.equal(t.p.state(), "waiting");
  assert.equal(t.waiting.length, 0);
  t.p.settled("FR", "rise");
  assert.equal(t.p.state(), "armed");
  assert.deepEqual(t.asked, []); // waits for the map at rest
  assert.equal(t.waiting.length, 1);
});

test("at rest the first unit is asked; the second waits for its answer and a rest of its own", async () => {
  const t = setup();
  t.p.settled("FR", "rise");
  t.rest();
  assert.deepEqual(t.scopes, ["FR"]);
  assert.deepEqual(t.asked, ["fr:reg:84"]);
  assert.equal(t.waiting.length, 0); // one at a time
  await t.answer();
  assert.deepEqual(t.asked, ["fr:reg:84"]);
  assert.equal(t.waiting.length, 1);
  t.rest();
  assert.deepEqual(t.asked, ["fr:reg:84", "fr:reg:11"]);
  await t.answer();
  assert.equal(t.p.state(), "done");
  assert.equal(t.waiting.length, 0);
  assert.deepEqual(t.p.asked(), ["fr:reg:84", "fr:reg:11"]);
});

test("once per page: a later plateau asks nothing more, the targets are read once", async () => {
  const t = setup(["fr:reg:84"]);
  t.p.settled("FR", "same");
  t.p.settled("fr:reg:84", "rise"); // armed already: the first plateau's unit stays
  t.rest();
  await t.answer();
  assert.equal(t.p.state(), "done");
  t.p.settled("fr:reg:11", "rise");
  assert.equal(t.waiting.length, 0);
  assert.deepEqual(t.scopes, ["FR"]);
  assert.deepEqual(t.asked, ["fr:reg:84"]);
});

test("not allowed at the rest: nothing is asked, and the prefetch is over", async () => {
  const t = setup();
  t.p.settled("FR", "rise");
  t.forbid();
  t.rest();
  assert.deepEqual(t.asked, []);
  assert.deepEqual(t.scopes, []);
  assert.equal(t.p.state(), "done");
  // Forbidden between the two files: the second is not asked.
  const u = setup();
  u.p.settled("FR", "rise");
  u.rest();
  await u.answer();
  u.forbid();
  u.rest();
  assert.deepEqual(u.asked, ["fr:reg:84"]);
  assert.equal(u.p.state(), "done");
});

test("no unit to ask: over at the first rest", () => {
  const t = setup([]);
  t.p.settled("FR", "rise");
  t.rest();
  assert.deepEqual(t.asked, []);
  assert.equal(t.p.state(), "done");
});

test("stop cancels the wait, and an answer after it asks nothing", async () => {
  const t = setup();
  t.p.settled("FR", "rise");
  t.p.stop();
  assert.equal(t.cancelledCount(), 1);
  assert.equal(t.p.state(), "done");
  const u = setup();
  u.p.settled("FR", "rise");
  u.rest();
  u.p.stop();
  await u.answer();
  assert.equal(u.waiting.length, 0);
  assert.deepEqual(u.asked, ["fr:reg:84"]);
});

test("a request that rejects is over like one that answers", async () => {
  const waiting: (() => void)[] = [];
  const asked: string[] = [];
  const p = idlePrefetch({
    allowed: () => true,
    targets: () => ["a", "b"],
    prefetch: (id) => {
      asked.push(id);
      return Promise.reject(new Error("network"));
    },
    whenAtRest: (job) => {
      waiting.push(job);
      return () => {};
    },
  });
  p.settled("FR", "rise");
  waiting.shift()!();
  await flush();
  waiting.shift()!();
  await flush();
  assert.deepEqual(asked, ["a", "b"]);
  assert.equal(p.state(), "done");
});

test("the units asked: the most testimonies first, ties in the list's order, none empty or without a file", () => {
  const rows = [
    { id: "a", count: 3 },
    { id: "b", count: 12 },
    { id: "c", count: 0 },
    { id: "d", count: 12 },
    { id: "e", count: 40 },
    { id: "f", count: 7 },
  ];
  const all = () => true;
  assert.deepEqual(pickPrefetch(rows, 2, all), ["e", "b"]);
  assert.deepEqual(pickPrefetch(rows, 3, all), ["e", "b", "d"]);
  assert.deepEqual(pickPrefetch(rows, 1, all), ["e"]);
  assert.deepEqual(pickPrefetch(rows, 0, all), []);
  assert.deepEqual(pickPrefetch(rows, -1, all), []);
  assert.deepEqual(
    pickPrefetch(rows, 2, (id) => id !== "e"),
    ["b", "d"],
  );
  assert.deepEqual(pickPrefetch(rows, 9, all), ["e", "b", "d", "f", "a"]);
  assert.deepEqual(pickPrefetch([], 2, all), []);
  // The rows are left as they were.
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a", "b", "c", "d", "e", "f"],
  );
});

test("allowed: the switch on, the files, no hovering pointer, no Save-Data, no slow link", () => {
  const ok: PrefetchGuard = {
    mode: "idle",
    files: true,
    hover: false,
    saveData: false,
    effectiveType: "4g",
  };
  assert.equal(prefetchAllowed(ok), true);
  assert.equal(prefetchAllowed({ ...ok, effectiveType: null }), true); // Safari, Firefox: not said
  assert.equal(prefetchAllowed({ ...ok, mode: "off" }), false);
  assert.equal(prefetchAllowed({ ...ok, files: false }), false);
  assert.equal(prefetchAllowed({ ...ok, hover: true }), false);
  assert.equal(prefetchAllowed({ ...ok, saveData: true }), false);
  for (const slow of ["slow-2g", "2g", "3g"]) {
    assert.equal(prefetchAllowed({ ...ok, effectiveType: slow }), false, slow);
  }
});

test("two units on a full device, one on a weaker one", () => {
  assert.equal(prefetchUnits("full"), PREFETCH_UNITS);
  assert.equal(prefetchUnits("light"), PREFETCH_UNITS_WEAK);
  assert.equal(prefetchUnits("minimal"), PREFETCH_UNITS_WEAK);
  assert.equal(PREFETCH_UNITS, 2);
  assert.equal(PREFETCH_UNITS_WEAK, 1);
});
