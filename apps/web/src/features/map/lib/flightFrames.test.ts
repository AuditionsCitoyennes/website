// The frames of a camera flight (flightFrames.ts), run with
// `node --import tsx --test` (root "test:scripts"): the thread's work read
// from the pings, a flight's samples, the limits, and — through the device
// tier's own judge — which part of a device the samples call slow.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FREE_PING_MS,
  MAX_FLIGHT_FRAMES,
  MAX_FLIGHT_PINGS,
  PING_HOLD_MS,
  flightFrames,
  flightTells,
  threadWork,
} from "./flightFrames";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const tier = await import("../../../shared/device/deviceTier");

/** Pings every `every` ms from `from` to `to` (both included when they fall on a step). */
const pingsEvery = (from: number, to: number, every = PING_HOLD_MS) => {
  const out: number[] = [];
  for (let t = from; t <= to; t += every) out.push(t);
  return out;
};

test("threadWork: a thread that answers every ping in time did no work", () => {
  assert.equal(PING_HOLD_MS, 4);
  assert.equal(FREE_PING_MS, 8);
  assert.equal(threadWork(pingsEvery(0, 1000), 0, 1000), 0);
  // Up to FREE_PING_MS between two pings is a timer's own jitter.
  assert.equal(threadWork(pingsEvery(0, 1000, FREE_PING_MS), 0, 1000), 0);
  assert.equal(threadWork([], 0, 100), 0);
  assert.equal(threadWork([0], 0, 100), 0);
});

test("threadWork: a late ping found the thread busy since its timer was due", () => {
  // Free until 100, then a 50 ms task: the ping due at 104 comes at 150.
  const pings = [...pingsEvery(0, 100), 150, ...pingsEvery(154, 300)];
  assert.equal(threadWork(pings, 0, 300), 46);
  // Only the part inside the window counts.
  assert.equal(threadWork(pings, 120, 300), 30);
  assert.equal(threadWork(pings, 0, 130), 26);
  assert.equal(threadWork(pings, 110, 140), 30);
  assert.equal(threadWork(pings, 150, 300), 0);
  assert.equal(threadWork(pings, 0, 100), 0);
  // A browser that holds its timers 16 ms reads as busy three quarters of the time.
  assert.equal(threadWork(pingsEvery(0, 160, 16), 0, 160), 120);
});

test("a flight on a strong device: frames on time, no work to speak of", () => {
  const f = flightFrames(1000);
  for (let t = 1004; t <= 1500; t += 4) {
    f.ping(t);
    if ((t - 1000) % 16 === 0) f.frame(t);
  }
  const samples = f.end(1500);
  assert.equal(samples.length, 31);
  for (const s of samples) assert.deepEqual(s, { ms: 16, workMs: 0 });
  assert.equal(flightTells(samples, tier.MIN_FLIGHT_FRAMES, tier.MIN_FLIGHT_MS), true);
  assert.equal(tier.judgeFrameTimes(samples), null);
});

test("frames late while the thread works: the processor", () => {
  // Every frame 60 ms after the one before, the thread busy 52 ms of each:
  // one ping gets through after a frame, the next comes with the frame after.
  const f = flightFrames(0);
  for (let i = 1; i <= 12; i++) {
    f.ping(i * 60 - 56);
    f.frame(i * 60);
    f.ping(i * 60);
  }
  const samples = f.end(12 * 60);
  assert.equal(samples.length, 12);
  for (const s of samples) assert.deepEqual(s, { ms: 60, workMs: 52 });
  assert.deepEqual(tier.judgeFrameTimes(samples), { tier: "light", kind: "cpu" });
});

test("frames late while the thread sits free: the graphics", () => {
  // Every frame 60 ms after the one before, the map's own work 6 ms of each
  // (the ping due during it comes 6 ms late), the rest spent waiting.
  const f = flightFrames(0);
  for (let i = 1; i <= 12; i++) {
    const start = (i - 1) * 60;
    for (let t = start + 4; t <= start + 48; t += 4) f.ping(t);
    f.frame(i * 60); // drawn at the end of the 6 ms of work begun at start + 54
    f.ping(i * 60);
  }
  const samples = f.end(12 * 60);
  assert.equal(samples.length, 12);
  for (const s of samples) assert.deepEqual(s, { ms: 60, workMs: 8 });
  assert.deepEqual(tier.judgeFrameTimes(samples), { tier: "light", kind: "gpu" });
});

test("the first frame counts from the flight's beginning, the last wait is closed at its end", () => {
  const f = flightFrames(100);
  // No ping gets through before the first frame, 80 ms after the command.
  f.frame(180);
  f.ping(181);
  f.ping(185);
  f.frame(196);
  // The flight ends 30 ms after the last ping, no ping since: the thread was busy.
  f.frame(215);
  const samples = f.end(215);
  assert.deepEqual(samples, [
    { ms: 80, workMs: 76 },
    { ms: 16, workMs: 8 }, // 1 ms of the first wait, 7 of the last
    { ms: 19, workMs: 19 },
  ]);
  assert.equal(flightTells(samples, 5, 250), false);
  assert.equal(flightTells(samples, 3, 100), true);
  assert.equal(flightTells(samples, 3, 116), false);
  assert.equal(flightTells([], 0, 0), true);
  assert.equal(flightTells([20, 30, { ms: 50 }], 3, 100), true);
});

test("times that go backwards are dropped, a frame at the beginning is no frame", () => {
  const f = flightFrames(100);
  f.frame(100);
  f.frame(90);
  f.ping(50);
  f.frame(116);
  f.frame(116);
  f.frame(110);
  f.ping(120);
  f.frame(132);
  assert.deepEqual(f.end(132), [
    { ms: 16, workMs: 12 },
    { ms: 16, workMs: 12 },
  ]);
});

test("past a limit the flight is too long to judge: nothing comes out", () => {
  const frames = flightFrames(0);
  for (let i = 1; i <= MAX_FLIGHT_FRAMES + 5; i++) frames.frame(i * 16);
  assert.equal(frames.full(), true);
  assert.deepEqual(frames.end(1e6), []);

  const pings = flightFrames(0);
  for (let i = 1; i <= MAX_FLIGHT_PINGS + 5; i++) pings.ping(i * 4);
  pings.frame(20000);
  assert.equal(pings.full(), true);
  assert.deepEqual(pings.end(1e6), []);

  const short = flightFrames(0);
  short.frame(16);
  assert.equal(short.full(), false);
  assert.equal(short.end(16).length, 1);
});
