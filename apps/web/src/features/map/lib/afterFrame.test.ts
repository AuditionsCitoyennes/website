// A job put off until the next frame has been drawn (afterFrame.ts), over a
// fake clock with frames fired by hand: the job runs in a task after the
// frame, never inside it; a burst runs the last job once; a hidden tab's cap;
// flush and cancel; no frame asked for while nothing waits. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AFTER_FRAME_CAP_MS, createAfterFrame, type FrameClock } from "./afterFrame";

function rig() {
  let now = 0;
  let nextId = 1;
  let frames: { id: number; fn: () => void }[] = [];
  let timers: { id: number; fn: () => void; at: number }[] = [];
  let framesAsked = 0;
  const clock: FrameClock = {
    requestAnimationFrame(fn) {
      framesAsked++;
      const id = nextId++;
      frames.push({ id, fn });
      return id;
    },
    cancelAnimationFrame(id) {
      frames = frames.filter((f) => f.id !== id);
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.push({ id, fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  return {
    after: createAfterFrame(clock),
    /** A frame: its callbacks run (those asked during it wait for the next). */
    frame() {
      const due = frames;
      frames = [];
      for (const f of due) f.fn();
    },
    /** Every timer task due within `ms`, in time order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = Math.max(now, due.at);
        due.fn();
      }
      now = end;
    },
    framesAsked: () => framesAsked,
    waiting: () => ({ frames: frames.length, timers: timers.length }),
  };
}

test("the job runs in a task after the next frame, not inside it", () => {
  const r = rig();
  let ran = 0;
  r.after.schedule(() => ran++);
  assert.equal(r.after.pending(), true);
  r.advance(0);
  assert.equal(ran, 0, "no frame yet: a timer task alone does not run it");
  r.frame();
  assert.equal(ran, 0, "not inside the frame's callbacks");
  r.advance(0);
  assert.equal(ran, 1);
  assert.equal(r.after.pending(), false);
  // Nothing left behind: no frame, no timer (the cap is cleared).
  assert.deepEqual(r.waiting(), { frames: 0, timers: 0 });
  r.frame();
  r.advance(1000);
  assert.equal(ran, 1);
});

test("a burst of jobs runs the last one, once, at the first turn", () => {
  const r = rig();
  const ran: string[] = [];
  r.after.schedule(() => ran.push("a"));
  r.after.schedule(() => ran.push("b"));
  r.frame();
  // Between the frame and its task: still replaced, still that turn.
  r.after.schedule(() => ran.push("c"));
  assert.equal(r.framesAsked(), 1);
  r.advance(0);
  assert.deepEqual(ran, ["c"]);
  assert.deepEqual(r.waiting(), { frames: 0, timers: 0 });
});

test("a job scheduled by a job waits for its own frame", () => {
  const r = rig();
  const ran: string[] = [];
  r.after.schedule(() => {
    ran.push("a");
    r.after.schedule(() => ran.push("b"));
  });
  r.frame();
  r.advance(0);
  assert.deepEqual(ran, ["a"]);
  assert.equal(r.after.pending(), true);
  r.frame();
  r.advance(0);
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(r.framesAsked(), 2);
});

test("without a frame (a hidden tab) the job runs at the cap", () => {
  const r = rig();
  let ran = 0;
  r.after.schedule(() => ran++);
  r.advance(AFTER_FRAME_CAP_MS - 1);
  assert.equal(ran, 0);
  r.advance(1);
  assert.equal(ran, 1);
  // The frame, when it comes at last, has nothing to run.
  r.frame();
  r.advance(0);
  assert.equal(ran, 1);
  assert.deepEqual(r.waiting(), { frames: 0, timers: 0 });
});

test("flush runs the job now, cancel drops it; both leave nothing waiting", () => {
  const r = rig();
  let ran = 0;
  r.after.flush();
  assert.equal(ran, 0, "nothing waits: nothing runs");
  r.after.schedule(() => ran++);
  r.after.flush();
  assert.equal(ran, 1);
  assert.deepEqual(r.waiting(), { frames: 0, timers: 0 });
  r.after.schedule(() => ran++);
  r.frame();
  r.after.cancel();
  assert.equal(r.after.pending(), false);
  r.advance(AFTER_FRAME_CAP_MS);
  assert.equal(ran, 1);
  assert.deepEqual(r.waiting(), { frames: 0, timers: 0 });
});

test("no frame is asked for while nothing waits: one per job", () => {
  const r = rig();
  assert.equal(r.framesAsked(), 0);
  for (let i = 0; i < 3; i++) {
    r.after.schedule(() => {});
    r.frame();
    r.advance(0);
  }
  assert.equal(r.framesAsked(), 3);
  r.frame();
  r.frame();
  assert.equal(r.framesAsked(), 3);
});
