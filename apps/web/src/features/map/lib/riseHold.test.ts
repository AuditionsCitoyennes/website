// The rise's hold (riseHold.ts): the rise starts after the gate and whatever
// else it waits for, never synchronously and never from a frame; a drop ends
// it "dropped"; a second wait, or a run that rises at once, makes the first
// "taken", and only the second can start. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRiseHold, type RiseStart } from "./riseHold";

/** A clock by hand: timers run when `advance` reaches them. */
function fakeClock() {
  let t = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(next, { at: t + ms, fn });
      return next++;
    },
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    advance(ms: number) {
      t += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > t) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    pending: () => timers.size,
  };
}

/** The microtasks queued so far, run. */
const settle = () => new Promise<void>((r) => setImmediate(r));

function track(p: Promise<RiseStart>) {
  const box: { how: RiseStart | null } = { how: null };
  void p.then((how) => (box.how = how));
  return box;
}

test("the rise starts once the gate has passed, not before", async () => {
  const clock = fakeClock();
  const hold = createRiseHold(clock);
  const w = track(hold.wait("fr:reg:84", 117));
  assert.equal(hold.waiting(), "fr:reg:84");
  clock.advance(116);
  await settle();
  assert.equal(w.how, null);
  clock.advance(1);
  await settle();
  assert.equal(w.how, "start");
  assert.equal(hold.waiting(), "");
  assert.equal(clock.pending(), 0);
});

test("a gate of 0 takes a task: nothing resolves synchronously", async () => {
  const clock = fakeClock();
  const hold = createRiseHold(clock);
  const w = track(hold.wait("a", 0));
  await settle();
  assert.equal(w.how, null); // no timer has run: no frame, no microtask starts it
  clock.advance(0);
  await settle();
  assert.equal(w.how, "start");
});

test("a negative gate is a gate of 0", async () => {
  const clock = fakeClock();
  const hold = createRiseHold(clock);
  const w = track(hold.wait("a", -40));
  clock.advance(0);
  await settle();
  assert.equal(w.how, "start");
});

test("drop: the wait ends dropped, its timer cleared", async () => {
  const clock = fakeClock();
  const hold = createRiseHold(clock);
  const w = track(hold.wait("a", 117));
  hold.drop();
  await settle();
  assert.equal(w.how, "dropped");
  assert.equal(clock.pending(), 0);
  clock.advance(500);
  await settle();
  assert.equal(w.how, "dropped");
  hold.drop(); // nothing waits: nothing happens
});

test("a second wait makes the first taken, and only the second can start", async () => {
  const clock = fakeClock();
  const hold = createRiseHold(clock);
  const first = track(hold.wait("a", 117));
  clock.advance(50);
  const second = track(hold.wait("a", 67));
  await settle();
  assert.equal(first.how, "taken");
  assert.equal(second.how, null);
  clock.advance(67);
  await settle();
  assert.equal(first.how, "taken");
  assert.equal(second.how, "start");
});

test("take: a run that rises at once ends the wait under way as taken", async () => {
  const clock = fakeClock();
  const hold = createRiseHold(clock);
  const w = track(hold.wait("a", 117));
  hold.take();
  await settle();
  assert.equal(w.how, "taken");
  assert.equal(hold.waiting(), "");
});

test("with something else to wait for: both must be over, in either order", async () => {
  const clock = fakeClock();
  const hold = createRiseHold(clock);
  let land!: () => void;
  let cancelled = 0;
  const also = { done: new Promise<void>((r) => (land = r)), cancel: () => void cancelled++ };
  const w = track(hold.wait("a", 47, also));
  clock.advance(47);
  await settle();
  assert.equal(w.how, null); // the gate alone is not enough
  land();
  await settle();
  assert.equal(w.how, "start");
  assert.equal(cancelled, 0);

  let land2!: () => void;
  const also2 = { done: new Promise<void>((r) => (land2 = r)), cancel: () => void cancelled++ };
  const w2 = track(hold.wait("b", 47, also2));
  land2();
  await settle();
  assert.equal(w2.how, null); // nor is the landing alone
  clock.advance(47);
  await settle();
  assert.equal(w2.how, "start");
});

test("a wait dropped or taken cancels what else it waited for", async () => {
  const clock = fakeClock();
  const hold = createRiseHold(clock);
  let cancelled = 0;
  const also = () => ({ done: new Promise<void>(() => {}), cancel: () => void cancelled++ });
  const a = track(hold.wait("a", 10, also()));
  hold.drop();
  const b = track(hold.wait("b", 10, also()));
  const c = track(hold.wait("b", 10));
  await settle();
  assert.deepEqual([a.how, b.how, c.how], ["dropped", "taken", null]);
  assert.equal(cancelled, 2);
});
