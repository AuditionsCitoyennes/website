import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE, selectAll } from "./paging";

// `node --import tsx --test src/lib/paging.test.ts` (npm test in apps/api).

type Reply = { data: number[] | null; error: { message: string } | null };

/** A read whose pages answer from `replies`, in order, logging each range asked. */
function pages(replies: Reply[]) {
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const reply = replies.shift();
    if (!reply) throw new Error(`page ${from}-${to} was not expected`);
    return Promise.resolve(reply);
  };
  return { calls, page };
}

const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

test("reads page after page until a short one, in order", async () => {
  const { calls, page } = pages([
    { data: rows(0, PAGE), error: null },
    { data: rows(PAGE, PAGE), error: null },
    { data: rows(2 * PAGE, 3), error: null },
  ]);
  const { data, error } = await selectAll(page);
  assert.equal(error, null);
  assert.deepEqual(data, rows(0, 2 * PAGE + 3));
  assert.deepEqual(calls, [
    [0, 999],
    [1000, 1999],
    [2000, 2999],
  ]);
});

test("a full last page costs one more, empty, read", async () => {
  const { calls, page } = pages([
    { data: rows(0, PAGE), error: null },
    { data: [], error: null },
  ]);
  const { data } = await selectAll(page);
  assert.equal(data?.length, PAGE);
  assert.equal(calls.length, 2);
});

test("an empty or a null first page: no rows, one read", async () => {
  for (const first of [[], null]) {
    const { calls, page } = pages([{ data: first, error: null }]);
    assert.deepEqual(await selectAll(page), { data: [], error: null });
    assert.equal(calls.length, 1);
  }
});

test("an error stops the reads and drops the rows read before it", async () => {
  const failure = { message: "canceling statement due to statement timeout" };
  const { calls, page } = pages([
    { data: rows(0, PAGE), error: null },
    { data: null, error: failure },
  ]);
  const result = await selectAll(page);
  assert.deepEqual(result, { data: null, error: failure });
  assert.equal(calls.length, 2);
});

test("a page that throws rejects the whole read", async () => {
  const boom = new Error("fetch failed");
  await assert.rejects(
    selectAll(() => Promise.reject(boom)),
    (e) => e === boom,
  );
});
