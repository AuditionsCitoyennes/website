// The time limit on the API's reads (readTimeout.ts), run with
// `node --import tsx --test` (root "test:scripts"): an answer in time passes
// through, a stalled read is sent once more and then fails as a network
// failure (a TypeError), a caller's abort is never retried, and every timer
// armed is cleared.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiTimeoutError, READ_ATTEMPTS, READ_TIMEOUT_MS, readWithin } from "./readTimeout";

/** Timers fired by hand. */
function clock() {
  let next = 1;
  const live = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      live.set(id, { fn, ms });
      return id;
    },
    clearTimer: (t: unknown) => void live.delete(t as number),
    fireAll() {
      const due = [...live.values()];
      live.clear();
      for (const t of due) t.fn();
    },
    live,
  };
}

/** A read that never answers until its signal aborts. */
function stalled(calls: AbortSignal[]) {
  return (signal: AbortSignal) =>
    new Promise<string>((_, reject) => {
      calls.push(signal);
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      // As fetch: a signal already aborted rejects at once.
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort);
    });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("the limit is 25 s, the read sent twice at most", () => {
  assert.equal(READ_TIMEOUT_MS, 25_000);
  assert.equal(READ_ATTEMPTS, 2);
});

test("an answer in time passes through, its timer cleared", async () => {
  const c = clock();
  const out = await readWithin(async () => "ok", c);
  assert.equal(out, "ok");
  assert.equal(c.live.size, 0);
});

test("a read that stalls is sent once more, then fails as a TypeError", async () => {
  const c = clock();
  const calls: AbortSignal[] = [];
  const p = readWithin(stalled(calls), { ...c, ms: 1000 });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal([...c.live.values()][0].ms, 1000);
  c.fireAll();
  await tick();
  assert.equal(calls.length, 2, "sent again at once");
  assert.equal(calls[0].aborted, true);
  c.fireAll();
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof ApiTimeoutError);
    assert.ok(err instanceof TypeError, "retried by readers as a network failure");
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(c.live.size, 0);
});

test("the second attempt answering in time wins", async () => {
  const c = clock();
  let n = 0;
  const p = readWithin(
    (signal) => (++n === 1 ? stalled([])(signal) : Promise.resolve("second")),
    c,
  );
  await tick();
  c.fireAll();
  assert.equal(await p, "second");
  assert.equal(n, 2);
});

test("a caller's abort rejects at once and is never retried", async () => {
  const c = clock();
  const calls: AbortSignal[] = [];
  const caller = new AbortController();
  const p = readWithin(stalled(calls), { ...c, signal: caller.signal });
  await tick();
  caller.abort();
  await assert.rejects(p, (err: Error) => err.name === "AbortError");
  assert.equal(calls.length, 1);
  assert.equal(c.live.size, 0);
});

test("a signal aborted before the read starts aborts the read's own", async () => {
  const c = clock();
  const caller = new AbortController();
  caller.abort();
  const calls: AbortSignal[] = [];
  await assert.rejects(readWithin(stalled(calls), { ...c, signal: caller.signal }));
  assert.equal(calls[0].aborted, true);
  assert.equal(calls.length, 1);
});

test("an error other than the time-out (an API refusal) is not retried", async () => {
  const c = clock();
  let n = 0;
  const refusal = new Error("503");
  await assert.rejects(
    readWithin(async () => {
      n++;
      throw refusal;
    }, c),
    (err) => err === refusal,
  );
  assert.equal(n, 1);
});

test("one attempt only when asked", async () => {
  const c = clock();
  const calls: AbortSignal[] = [];
  const p = readWithin(stalled(calls), { ...c, attempts: 1 });
  await tick();
  c.fireAll();
  await assert.rejects(p, ApiTimeoutError);
  assert.equal(calls.length, 1);
});
