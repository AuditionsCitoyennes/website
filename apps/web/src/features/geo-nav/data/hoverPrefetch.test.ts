// The row-hover prefetch's timing (hoverPrefetch.ts) on a scripted clock.
// Run with `node --import tsx --test` (root "test:scripts"). Pure: no Vue.

import assert from "node:assert/strict";
import { test } from "node:test";
import { HOVER_HOLD_MS, hoverPrefetch } from "./hoverPrefetch";

function setup(allowed = () => true) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const asked: string[] = [];
  const answers: (() => void)[] = [];
  const h = hoverPrefetch({
    prefetch: (id) => {
      asked.push(id);
      return new Promise<void>((done) => answers.push(done));
    },
    allowed,
    setTimer: (fn, ms) => {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimer: (t) => void timers.delete(t as number),
  });
  const tick = async (ms: number) => {
    now += ms;
    for (const [t, { at, fn }] of [...timers])
      if (at <= now) {
        timers.delete(t);
        fn();
      }
    await new Promise((r) => setImmediate(r));
  };
  /** The oldest request under way answers. */
  const answer = async () => {
    answers.shift()!();
    await new Promise((r) => setImmediate(r));
  };
  return { h, asked, tick, answer };
}

test("a row held 150 ms is asked once; a shorter hover asks nothing", async () => {
  const t = setup();
  t.h.hover("fr:reg:84");
  await t.tick(HOVER_HOLD_MS - 1);
  t.h.hover("fr:reg:93"); // moved on before the hold
  await t.tick(HOVER_HOLD_MS - 1);
  t.h.hover(null);
  await t.tick(1_000);
  assert.deepEqual(t.asked, []);
  t.h.hover("fr:reg:84");
  await t.tick(HOVER_HOLD_MS);
  assert.deepEqual(t.asked, ["fr:reg:84"]);
});

test("one in flight: a row held meanwhile is asked once it settles, if still held", async () => {
  const t = setup();
  t.h.hover("fr:reg:84");
  await t.tick(HOVER_HOLD_MS);
  t.h.hover("fr:reg:93");
  await t.tick(HOVER_HOLD_MS);
  t.h.hover("fr:reg:76");
  await t.tick(HOVER_HOLD_MS);
  assert.deepEqual(t.asked, ["fr:reg:84"]);
  await t.answer();
  assert.deepEqual(t.asked, ["fr:reg:84", "fr:reg:76"]); // 93 was left
  await t.answer();
  t.h.hover(null);
  t.h.hover("fr:reg:52");
  await t.tick(HOVER_HOLD_MS);
  t.h.hover(null); // left while it is under way
  await t.answer();
  assert.deepEqual(t.asked, ["fr:reg:84", "fr:reg:76", "fr:reg:52"]);
});

test("not allowed (no hovering pointer, Save-Data): nothing asked", async () => {
  const t = setup(() => false);
  t.h.hover("fr:reg:84");
  await t.tick(1_000);
  assert.deepEqual(t.asked, []);
});

test("stop drops a hold under way", async () => {
  const t = setup();
  t.h.hover("fr:reg:84");
  t.h.stop();
  await t.tick(1_000);
  assert.deepEqual(t.asked, []);
});
