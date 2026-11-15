// The time limit under the API's Supabase clients (timedFetch.ts): a read and
// a write get their own limit, a stalled call ends in a TimeoutError (what
// dbGate reads as a database out of reach), a caller's signal still aborts it,
// an answer in time passes through untouched, and the capped fetch composes
// over it.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cappedFetch } from "./cappedFetch";
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, timedFetch } from "./timedFetch";

// AbortSignal.timeout's timer does not hold the process open (a server's
// sockets do): this one does, while the tests wait on it.
const keep = setInterval(() => {}, 1_000);
after(() => clearInterval(keep));

/** A fetch that never answers until its signal aborts; records each call's signal. */
function stalled(seen: { method: string; signal: AbortSignal }[]): typeof fetch {
  return (input, init) =>
    new Promise((_, reject) => {
      const signal = init!.signal!;
      seen.push({ method: init?.method ?? "GET", signal });
      const fail = () => reject(signal.reason);
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail);
    });
}

test("the limits: 15 s for a read, 30 s for anything else", () => {
  assert.equal(READ_TIMEOUT_MS, 15_000);
  assert.equal(WRITE_TIMEOUT_MS, 30_000);
});

test("a read that stalls ends in a TimeoutError past its limit", async () => {
  const seen: { method: string; signal: AbortSignal }[] = [];
  const f = timedFetch(stalled(seen), { readMs: 20, writeMs: 5_000 });
  const started = Date.now();
  await assert.rejects(f("http://db.test/rest/v1/auditions"), (err: Error) => {
    assert.equal(err.name, "TimeoutError");
    return true;
  });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(seen[0].signal.aborted, true);
});

test("a write gets its own, longer limit", async () => {
  const seen: { method: string; signal: AbortSignal }[] = [];
  const f = timedFetch(stalled(seen), { readMs: 5_000, writeMs: 20 });
  await assert.rejects(
    f("http://db.test/rest/v1/rpc/x", { method: "post" }),
    (err: Error) => err.name === "TimeoutError",
  );
  const g = timedFetch(stalled(seen), { readMs: 20, writeMs: 5_000 });
  const ctl = new AbortController();
  const p = g("http://db.test/rest/v1/rpc/x", { method: "POST", signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(seen[1].signal.aborted, false, "not ended by the read's limit");
  ctl.abort();
  await assert.rejects(p);
});

test("the caller's signal still aborts the call, with its own reason", async () => {
  const seen: { method: string; signal: AbortSignal }[] = [];
  const f = timedFetch(stalled(seen), { readMs: 5_000 });
  const ctl = new AbortController();
  const p = f("http://db.test/rest/v1/auditions", { signal: ctl.signal });
  ctl.abort(new DOMException("gate", "AbortError"));
  await assert.rejects(p, (err: Error) => err.name === "AbortError");
});

test("an answer in time passes through untouched, and the capped fetch composes over it", async () => {
  const answer = new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const f = timedFetch(async () => answer, { readMs: 50 });
  assert.equal(await f("http://db.test/x"), answer);
  const capped = cappedFetch(
    1_000,
    timedFetch(async () => new Response('{"n":1}'), { readMs: 50 }),
  );
  assert.deepEqual(await (await capped("http://db.test/x")).json(), { n: 1 });
  const tooSmall = cappedFetch(
    3,
    timedFetch(async () => new Response('{"n":1}'), { readMs: 50 }),
  );
  await assert.rejects(
    tooSmall("http://db.test/x"),
    (err: Error) => err.name === "AnswerTooLargeError",
  );
});

test("a Request's own method decides the limit when init has none", async () => {
  const seen: { method: string; signal: AbortSignal }[] = [];
  const f = timedFetch(stalled(seen), { readMs: 5_000, writeMs: 20 });
  await assert.rejects(
    f(new Request("http://db.test/x", { method: "DELETE" })),
    (err: Error) => err.name === "TimeoutError",
  );
});
