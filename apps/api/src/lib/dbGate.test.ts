import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import {
  DbBusyError,
  dbErrorOf,
  DbGate,
  DbRefusedError,
  DbTimeoutError,
  isTransientDbError,
  newTiming,
} from "./dbGate";
import { takeHits } from "./rateLimit";

// The database gate (lib/dbGate.ts): so many calls at once, so many waiting
// so long, then 503; the slot of an aborted call held a while; what a
// failed call means. And the rate limiter's all-or-none count.

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The gate's abort and hold timers do not keep a process alive (a server's
// sockets do): a test's own timer does.
const alive = setInterval(() => {}, 1000);
after(() => clearInterval(alive));

const gate = (o: Partial<DbGate["opts"]> = {}) =>
  new DbGate({ max: 2, queue: 2, waitMs: 1000, timeoutMs: 1000, holdMs: 50, ...o });

/** A call that ends when told to. */
function held() {
  let end!: () => void;
  const done = new Promise<void>((r) => (end = r));
  return { run: () => done.then(() => "ok"), end };
}

test("at most `max` calls at once; the next wait their turn, in order", async () => {
  const g = gate();
  const a = held();
  const b = held();
  const order: string[] = [];
  const pa = g.run(a.run);
  const pb = g.run(b.run);
  const pc = g.run(async () => {
    order.push("c");
    return "c";
  });
  await tick(5);
  assert.deepEqual(g.stats(), { active: 2, held: 0, waiting: 1 });
  assert.deepEqual(order, [], "c waits for a slot");
  a.end();
  assert.equal(await pc, "c");
  b.end();
  await Promise.all([pa, pb]);
  assert.deepEqual(g.stats(), { active: 0, held: 0, waiting: 0 });
});

test("a full queue answers busy at once; a wait past waitMs answers busy", async () => {
  const g = gate({ waitMs: 30 });
  const slots = [held(), held()];
  const running = slots.map((s) => g.run(s.run));
  const queued = [g.run(async () => 1), g.run(async () => 2)];
  await assert.rejects(
    g.run(async () => 3),
    DbBusyError,
    "queue of 2 full",
  );
  await assert.rejects(queued[0], DbBusyError, "waited 30 ms");
  await assert.rejects(queued[1], DbBusyError);
  assert.equal(g.stats().waiting, 0);
  slots.forEach((s) => s.end());
  await Promise.all(running);
  assert.equal(await g.run(async () => "free again"), "free again");
});

test("an aborted call holds its slot a while after it settles", async () => {
  const g = gate({ max: 1, timeoutMs: 20, holdMs: 80 });
  // The call waits for its abort (what a fetch does).
  const aborted = g.run(
    (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("TimeoutError: aborted"))),
      ),
  );
  await assert.rejects(aborted, /TimeoutError/);
  assert.deepEqual(g.stats(), { active: 1, held: 1, waiting: 0 });
  let started = 0;
  const next = g.run(async () => (started = Date.now()));
  const t0 = Date.now();
  await next;
  assert.ok(started - t0 >= 60, `the next call waited for the hold (${started - t0} ms)`);
  assert.deepEqual(g.stats(), { active: 0, held: 0, waiting: 0 });
});

test("a call that ends on time frees its slot at once", async () => {
  const g = gate({ max: 1, holdMs: 10_000 });
  await g.run(async () => "quick");
  const t0 = Date.now();
  await g.run(async () => "next");
  assert.ok(Date.now() - t0 < 50);
});

test("timing: the wait for a slot and the calls", async () => {
  const g = gate({ max: 1 });
  const timing = newTiming();
  const first = g.run(() => tick(30));
  await g.run(() => tick(10), timing);
  await first;
  assert.equal(timing.calls, 1);
  assert.ok(timing.gateMs >= 20, `gate ${timing.gateMs}`);
  assert.ok(timing.dbMs >= 8, `db ${timing.dbMs}`);
});

test("what a failed call means: 57014 and aborts are timeouts, 22023 a refusal", () => {
  const live = new AbortController().signal;
  assert.ok(
    dbErrorOf({ code: "57014", message: "canceling statement" }, live) instanceof DbTimeoutError,
  );
  assert.ok(
    dbErrorOf({ code: "", message: "AbortError: This operation was aborted" }, live) instanceof
      DbTimeoutError,
  );
  assert.ok(
    dbErrorOf({ code: "", message: "TimeoutError: The operation timed out" }, live) instanceof
      DbTimeoutError,
  );
  assert.ok(
    dbErrorOf({ code: "", message: "fetch failed" }, AbortSignal.abort()) instanceof DbTimeoutError,
  );
  assert.ok(dbErrorOf({ code: "22023", message: "filters: bad" }, live) instanceof DbRefusedError);
  const other = dbErrorOf({ code: "42501", message: "permission denied" }, live);
  assert.ok(!(other instanceof DbTimeoutError) && !(other instanceof DbRefusedError));
  assert.equal(new DbTimeoutError("x").statusCode, 503);
  assert.equal(new DbTimeoutError("x").message, "Recherche trop large : précisez-la.");
  assert.equal(new DbBusyError().message, "Réessayez dans un instant.");
  assert.ok(isTransientDbError(new DbBusyError()) && isTransientDbError(new DbTimeoutError("")));
  assert.ok(!isTransientDbError(new DbRefusedError("")) && !isTransientDbError(new Error()));
});

test("takeHits: all or none, and how long until the refusing window ends", () => {
  const w = 10_000;
  assert.equal(takeHits([{ key: "t:a", n: 25, max: 30, windowMs: w }]), 0);
  // 6 more do not fit: nothing is counted, on either key.
  const wait = takeHits([
    { key: "t:a", n: 6, max: 30, windowMs: w },
    { key: "t:b", n: 6, max: 20, windowMs: w },
  ]);
  assert.ok(wait > 9_000 && wait <= w, `${wait}`);
  assert.equal(takeHits([{ key: "t:b", n: 20, max: 20, windowMs: w }]), 0, "t:b untouched");
  assert.equal(takeHits([{ key: "t:a", n: 5, max: 30, windowMs: w }]), 0);
  assert.ok(takeHits([{ key: "t:a", n: 1, max: 30, windowMs: w }]) > 0);
  // More than a window allows: refused for a window.
  assert.equal(takeHits([{ key: "t:c", n: 31, max: 30, windowMs: w }]), w);
});
