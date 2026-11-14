// The client relief's tile plumbing (demTiles.ts): the template parser, the
// answers' LRU, the per-frame budget and the FNV fallback hash. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FrameBudget,
  TileCache,
  demTemplate,
  fnv1a64,
  parseDemUrl,
  type FrameScheduler,
} from "./demTiles";

const KEY32 = "0123456789abcdef0123456789abcdef";

test("parseDemUrl: the template's own URLs, 32-hex and f-fallback keys", () => {
  const url = demTemplate(KEY32).replace("{z}", "3").replace("{x}", "7").replace("{y}", "0");
  assert.deepEqual(parseDemUrl(url), { key: KEY32, z: 3, x: 7, y: 0 });
  assert.deepEqual(parseDemUrl("ac-dem://f0011223344556677/0/0/0"), {
    key: "f0011223344556677",
    z: 0,
    x: 0,
    y: 0,
  });
});

test("parseDemUrl: anything else is null", () => {
  for (const bad of [
    `https://api/dem/${KEY32}/3/1/1`,
    `ac-dem:/${KEY32}/3/1/1`,
    `ac-dem://${KEY32}/3/1/1?x=1`,
    `ac-dem://${KEY32}/3/1/1#a`,
    `ac-dem://${KEY32}/3/1/1/`,
    `ac-dem://${KEY32}/3/1.5/1`,
    `ac-dem://${KEY32}/3/-1/1`,
    `ac-dem://${KEY32}/3/01/1`,
    `ac-dem://${KEY32}/3/8/1`, // x = 2^z
    `ac-dem://${KEY32}/3/1/8`,
    `ac-dem://${KEY32}/31/0/0`,
    `ac-dem://ABC/3/1/1`,
    `ac-dem:///3/1/1`,
    `ac-dem://${KEY32}/3/1`,
  ]) {
    assert.equal(parseDemUrl(bad), null, bad);
  }
});

test("fnv1a64: the reference vectors, and a BigInt reference on UTF-8", () => {
  assert.equal(fnv1a64(""), "cbf29ce484222325");
  assert.equal(fnv1a64("a"), "af63dc4c8601ec8c");
  assert.equal(fnv1a64("foobar"), "85944171f73967e8");
  const ref = (s: string) => {
    let h = 0xcbf29ce484222325n;
    for (const b of new TextEncoder().encode(s))
      h = ((h ^ BigInt(b)) * 0x100000001b3n) & (2n ** 64n - 1n);
    return h.toString(16).padStart(16, "0");
  };
  const s = '1\n{"polys":[[[[2.35,48.85],[-61.5,16.25]]]],"height":38} é ✓';
  assert.equal(fnv1a64(s), ref(s));
});

test("TileCache: same promise back, a hit refreshes recency, eviction at the cap, delete", () => {
  const c = new TileCache(3);
  const p = (s: string) => Promise.resolve(s);
  const a = p("a");
  c.set("a", a);
  c.set("b", p("b"));
  c.set("c", p("c"));
  assert.equal(c.get("a"), a); // a is now the newest
  c.set("d", p("d"));
  assert.equal(c.get("b"), undefined); // b was the oldest
  assert.equal(c.size, 3);
  c.delete("a", p("other")); // not that promise: kept
  assert.equal(c.get("a"), a);
  c.delete("a");
  assert.equal(c.get("a"), undefined);
  const big = new TileCache();
  for (let i = 0; i < 2001; i++) big.set(`k${i}`, a);
  assert.equal(big.size, 2000);
  assert.equal(big.get("k0"), undefined);
});

test("TileCache: a size read at each set, and a smaller one brings the cache down to it", () => {
  let max = 4;
  const c = new TileCache(() => max);
  const p = Promise.resolve("p");
  for (const k of ["a", "b", "c", "d", "e"]) c.set(k, p);
  assert.equal(c.size, 4);
  assert.equal(c.get("a"), undefined);
  max = 2; // the device's tier fell meanwhile
  c.set("f", p);
  assert.equal(c.size, 2);
  assert.equal(c.get("e"), p);
  assert.equal(c.get("f"), p);
  assert.equal(c.get("d"), undefined);
  // Never below the entry just set.
  max = 0;
  c.set("g", p);
  assert.equal(c.size, 1);
  assert.equal(c.get("g"), p);
});

function fakeScheduler() {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let n = 0;
  const run = (m: Map<number, () => void>) => {
    const cbs = [...m.values()];
    m.clear();
    for (const cb of cbs) cb();
  };
  const sched: FrameScheduler = {
    frame: (cb) => (frames.set(++n, cb), n),
    cancelFrame: (h) => frames.delete(h as number),
    timer: (cb) => (timers.set(++n, cb), n),
    cancelTimer: (h) => timers.delete(h as number),
  };
  return { sched, frames, timers, frame: () => run(frames), timer: () => run(timers) };
}

const flush = () => new Promise((r) => setImmediate(r));

test("FrameBudget: n per frame, lowest z first then FIFO, the queue drains", async () => {
  const f = fakeScheduler();
  const b = new FrameBudget(2, f.sched);
  const order: string[] = [];
  const zs: [string, number][] = [
    ["a", 9],
    ["b", 7],
    ["c", 9],
    ["d", 7],
    ["e", 3],
  ];
  const all = zs.map(([s, z]) => b.release(z).then(() => order.push(s)));
  await flush();
  assert.deepEqual(order, []); // nothing before the frame
  f.frame();
  await flush();
  assert.deepEqual(order, ["e", "b"]);
  f.frame();
  await flush();
  assert.deepEqual(order, ["e", "b", "d", "a"]);
  f.frame();
  await Promise.all(all);
  assert.deepEqual(order, ["e", "b", "d", "a", "c"]);
  assert.equal(b.queued, 0);
  assert.equal(f.frames.size + f.timers.size, 0); // nothing scheduled once empty
});

test("FrameBudget: the timer takes the turn when rAF never fires, and cancels the frame", async () => {
  const f = fakeScheduler();
  const b = new FrameBudget(1, f.sched);
  let done = 0;
  void b.release(5).then(() => done++);
  void b.release(5).then(() => done++);
  f.timer();
  await flush();
  assert.equal(done, 1);
  // the next turn is armed again (frame + timer), the old frame cancelled
  assert.equal(f.frames.size, 1);
  assert.equal(f.timers.size, 1);
  f.frame();
  f.timer(); // the loser of the race does nothing
  await flush();
  assert.equal(done, 2);
  assert.equal(f.frames.size + f.timers.size, 0);
});

test("FrameBudget: n = 0 passes through, an idle budget schedules nothing", async () => {
  const f = fakeScheduler();
  const off = new FrameBudget(0, f.sched);
  await off.release(4);
  assert.equal(f.frames.size + f.timers.size, 0);
  new FrameBudget(4, f.sched);
  assert.equal(f.frames.size + f.timers.size, 0);
});

test("FrameBudget: each answer is released exactly once", async () => {
  const f = fakeScheduler();
  const b = new FrameBudget(3, f.sched);
  let resolved = 0;
  const ps = Array.from({ length: 7 }, () => b.release(1).then(() => resolved++));
  for (let i = 0; i < 5; i++) {
    f.frame();
    f.timer();
    await flush();
  }
  await Promise.all(ps);
  assert.equal(resolved, 7);
});
