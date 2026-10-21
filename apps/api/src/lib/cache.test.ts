import { test } from "node:test";
import assert from "node:assert/strict";
import { cached, invalidate, setCacheLogger } from "./cache";

// `node --import tsx --test src/lib/cache.test.ts` (npm test in apps/api).
// Each test has its own key: the store is module state.

setCacheLogger({ warn() {} });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a fill that started before invalidate() is not stored", async () => {
  let release!: (v: string) => void;
  const first = cached("race", 60_000, () => new Promise<string>((r) => (release = r)));
  invalidate("race");
  release("read before the write");
  // Its caller still gets what it asked for…
  assert.equal(await first, "read before the write");
  // …but the store stayed empty: the next read fills again, it does not get
  // the pre-write value for a full TTL.
  let fills = 0;
  const next = await cached("race", 60_000, async () => {
    fills++;
    return "after the write";
  });
  assert.equal(next, "after the write");
  assert.equal(fills, 1);
});

test("invalidate() drops the fill in flight: the next reader starts its own", async () => {
  let releaseOld!: (v: string) => void;
  const old = cached("inflight", 60_000, () => new Promise<string>((r) => (releaseOld = r)));
  invalidate("inflight");
  assert.equal(await cached("inflight", 60_000, async () => "new"), "new");
  releaseOld("old");
  assert.equal(await old, "old");
  // The old fill settling must not clear the newer fill's entry or slot.
  assert.equal(await cached("inflight", 60_000, async () => "third"), "new");
});

test("past its TTL a value is served stale at once and refilled behind the reply", async () => {
  let n = 0;
  const fn = async () => ++n;
  assert.equal(await cached("swr", 10, fn), 1);
  await tick(25);
  assert.equal(await cached("swr", 10, fn), 1); // stale: served, not awaited
  await tick(5); // the refill lands
  assert.equal(await cached("swr", 10, fn), 2);
  assert.equal(n, 2);
});

test("a failed refill keeps the last good value and backs off", async () => {
  let n = 0;
  const fn = async () => {
    n++;
    if (n > 1) throw new Error("upstream down");
    return "good";
  };
  assert.equal(await cached("outage", 10, fn), "good");
  await tick(25);
  assert.equal(await cached("outage", 10, fn), "good"); // the refill fails behind it
  await tick(5);
  assert.equal(await cached("outage", 10, fn), "good"); // still served; no new try yet
  assert.equal(n, 2);
});

test("invalidate() is a hard delete: nothing stale survives a write", async () => {
  await cached("hard", 60_000, async () => "old");
  invalidate("hard");
  assert.equal(await cached("hard", 60_000, async () => "new"), "new");
});

test("concurrent misses share one fill", async () => {
  let fills = 0;
  const fn = async () => {
    fills++;
    await tick(5);
    return "v";
  };
  const all = await Promise.all([cached("sf", 60_000, fn), cached("sf", 60_000, fn)]);
  assert.deepEqual(all, ["v", "v"]);
  assert.equal(fills, 1);
});
