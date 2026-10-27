import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ByteLru } from "./byteLru";
import {
  buildResponse,
  CacheFamily,
  KeyFailure,
  Prebuilt,
  responseOf,
  setCacheLogger,
} from "./cache";

// A family's rules (lib/cache.ts): bounded in bytes, least recently used out
// first; a value too heavy for it served and not kept; one generation, and a
// fill across a write not kept; served stale while refilled; single flight,
// per key and per batch; a held value instead of a transient error; a key's
// own failure within a batch, a response built by its fill, and the errors a
// family remembers.

setCacheLogger({ warn() {} });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A value whose JSON is about `n` bytes (gzip makes little of repeated text, so: random). */
const blob = (n: number, seed = 1) => {
  let x = seed;
  let s = "";
  while (s.length < n) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += x.toString(36);
  }
  return s.slice(0, n);
};

let names = 0;
const family = (opts: Partial<ConstructorParameters<typeof CacheFamily>[0]> = {}) =>
  new CacheFamily({ name: `t${++names}`, maxBytes: 100_000, ttlMs: 60_000, ...opts });

test("bytes are JSON + gzip, and the least recently used go past the budget", async () => {
  // Each entry ≈ 6 KB of JSON, 4 KB of gzip and its overhead: three fit, not four.
  const f = family({ maxBytes: 40_000, maxEntryBytes: 40_000 });
  for (const k of ["a", "b", "c"]) await f.get(k, async () => blob(6000, k.charCodeAt(0)));
  const { bytes, entries } = f.stats();
  assert.equal(entries, 3);
  assert.ok(bytes > 3 * 6000 && bytes <= 40_000, `${bytes}`);

  // "a" read again: "b" is now the oldest, and goes first.
  assert.equal((await f.get("a", async () => assert.fail("a is cached"))).state, "hit");
  await f.get("d", async () => blob(6000, 100));
  const st = f.stats();
  assert.ok(st.bytes <= 40_000, `${st.bytes}`);
  assert.equal(st.evictions, 1);
  let refetched = false;
  await f.get("b", async () => {
    refetched = true;
    return blob(6000, 98);
  });
  assert.ok(refetched, "the least recently used was evicted");
  assert.equal((await f.get("a", async () => assert.fail("a is kept"))).state, "hit");
});

test("a value heavier than an entry may be is served, not kept", async () => {
  const f = family({ maxBytes: 40_000 }); // entries up to 10,000 bytes
  let fills = 0;
  const big = async () => {
    fills++;
    return blob(12_000);
  };
  const first = await f.get("big", big);
  assert.equal(first.state, "miss");
  assert.ok(first.res.json.length >= 12_000);
  await f.get("big", big);
  assert.equal(fills, 2, "fetched again: not kept");
  assert.equal(f.stats().oversize, 2);
  assert.equal(f.stats().bytes, 0);
});

test("invalidate() bumps the generation: entries gone, a fill in flight not kept", async () => {
  const f = family();
  await f.get("k", async () => "before");
  let release!: (v: string) => void;
  const inFlight = f.get("other", () => new Promise<string>((r) => (release = r)));
  f.invalidate();
  assert.equal(f.stats().generation, 1);
  assert.equal(f.stats().entries, 0);
  release("read before the write");
  assert.equal(JSON.parse((await inFlight).res.json.toString()), "read before the write");
  let fills = 0;
  await f.get("other", async () => {
    fills++;
    return "after";
  });
  assert.equal(fills, 1, "the pre-write value was not kept");
  assert.equal(JSON.parse((await f.get("k", async () => "after")).res.json.toString()), "after");
});

test("invalidate() drops the fill in flight: the next reader starts its own", async () => {
  const f = family();
  let releaseOld!: (v: string) => void;
  const old = f.get("k", () => new Promise<string>((r) => (releaseOld = r)));
  f.invalidate();
  const fresh = await f.get("k", async () => "new");
  assert.equal(JSON.parse(fresh.res.json.toString()), "new");
  releaseOld("old");
  await old;
  // The old fill settling did not clear the newer entry.
  assert.equal((await f.get("k", async () => "third")).state, "hit");
});

test("delete() drops its keys alone, and a fill of them in flight", async () => {
  const f = family();
  await f.get("map", async () => 1);
  await f.get("list", async () => 2);
  let release!: (v: number) => void;
  const inFlight = f.get("geo", () => new Promise<number>((r) => (release = r)));
  f.delete("map", "geo");
  release(3);
  await inFlight;
  assert.equal((await f.get("list", async () => assert.fail("kept"))).state, "hit");
  assert.equal((await f.get("map", async () => 10)).state, "miss");
  assert.equal((await f.get("geo", async () => 30)).state, "miss");
});

test("past its TTL a value is served stale at once and refilled behind the reply", async () => {
  // A TTL with headroom: a loaded machine (the test files run in parallel)
  // must not see the refilled value go stale before it is read.
  const f = family({ ttlMs: 200 });
  let n = 0;
  const fn = async () => ++n;
  assert.equal((await f.get("swr", fn)).state, "miss");
  await tick(250);
  const stale = await f.get("swr", fn);
  assert.equal(stale.state, "stale");
  assert.equal(JSON.parse(stale.res.json.toString()), 1);
  // The refill lands behind the reply (its gzip runs on the threadpool).
  let next = await f.get("swr", fn);
  for (let i = 0; i < 100 && JSON.parse(next.res.json.toString()) < 2; i++) {
    await tick(5);
    next = await f.get("swr", fn);
  }
  assert.equal(JSON.parse(next.res.json.toString()), 2);
  assert.equal(next.state, "hit");
});

test("a failed refill keeps the last good value and backs off", async () => {
  const f = family({ ttlMs: 10 });
  let n = 0;
  const fn = async () => {
    n++;
    if (n > 1) throw new Error("upstream down");
    return "good";
  };
  await f.get("outage", fn);
  await tick(25);
  assert.equal((await f.get("outage", fn)).state, "stale");
  await tick(5);
  assert.equal((await f.get("outage", fn)).state, "stale");
  assert.equal(n, 2, "no new try while backing off");
});

test("past the stale window, a transient error serves the value still held; any other fails", async () => {
  const f = family({ ttlMs: 5, staleForMs: 5, holdForMs: 60_000 });
  class Timeout extends Error {}
  await f.get("held", async () => "last good");
  await tick(20);
  const served = await f.get(
    "held",
    async () => {
      throw new Timeout("57014");
    },
    { transient: (e) => e instanceof Timeout },
  );
  assert.equal(served.state, "stale");
  assert.equal(JSON.parse(served.res.json.toString()), "last good");
  await assert.rejects(
    f.get(
      "held",
      async () => {
        throw new Error("boom");
      },
      { transient: (e) => e instanceof Timeout },
    ),
    /boom/,
  );
  // Nothing held: the transient error itself.
  await assert.rejects(
    f.get(
      "never",
      async () => {
        throw new Timeout("57014");
      },
      { transient: (e) => e instanceof Timeout },
    ),
    Timeout,
  );
});

test("a value held answers transient errors for one more window, then is dropped", async () => {
  const f = family({ ttlMs: 5, staleForMs: 5, holdForMs: 300 });
  class Timeout extends Error {}
  const timeout = { transient: (e: unknown) => e instanceof Timeout };
  const fail = async () => {
    throw new Timeout("57014");
  };
  await f.get("old", async () => "hours ago");
  assert.ok(f.stats().bytes > 0);
  await tick(15);
  assert.equal((await f.get("old", fail, timeout)).state, "stale", "within the hold window");
  await tick(350);
  await assert.rejects(f.get("old", fail, timeout), Timeout, "past it: the error");
  assert.equal(f.stats().entries, 0, "dropped, its bytes given back");
  assert.equal(f.stats().bytes, 0);
});

test("a refused batch that joined another's fill leaves no rejection behind", async () => {
  const f = family();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    let fail!: (e: Error) => void;
    // A fills k1, slowly; B asks k1 (joined) and k2, and is refused (a 429).
    const a = f.getMany(["k1"], () => new Promise<unknown[]>((_, reject) => (fail = reject)));
    const b = f.getMany(["k1", "k2"], async (keys) => keys, {
      beforeFill: () => {
        throw new Error("429");
      },
    });
    await assert.rejects(b, /429/);
    fail(new Error("57014 timeout"));
    await assert.rejects(a, /57014/);
    await tick(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("refuseOversize: a value too heavy is refused, and not read again until its TTL ends", async () => {
  class TooLong extends Error {}
  const f = family({
    ttlMs: 300,
    maxBytes: 40_000,
    refuseOversize: (key, bytes) => new TooLong(`${key}: ${bytes}`),
  });
  let fills = 0;
  let size = 100;
  const fn = async () => {
    fills++;
    return blob(size);
  };
  await f.get("corpus", fn);
  size = 12_000; // over the 10,000 an entry may weigh
  await tick(320); // stale: the refill behind the reply finds it too heavy
  assert.equal((await f.get("corpus", fn)).state, "stale");
  for (let i = 0; i < 200 && f.stats().oversize === 0; i++) await tick(5);
  assert.equal(fills, 2);
  await assert.rejects(f.get("corpus", fn), TooLong, "the old value is not served past it");
  await assert.rejects(f.get("corpus", fn), TooLong);
  assert.equal(fills, 2, "the refusal is remembered");
  assert.equal(f.stats().bytes, 0);
  await tick(320);
  await assert.rejects(f.get("corpus", fn), TooLong);
  assert.equal(fills, 3, "read again once its TTL ended");
  f.invalidate();
  size = 100;
  assert.equal((await f.get("corpus", fn)).state, "miss", "a write: read again");
  assert.equal(fills, 4);
});

test("concurrent misses share one fill", async () => {
  const f = family();
  let fills = 0;
  const fn = async () => {
    fills++;
    await tick(5);
    return "v";
  };
  const all = await Promise.all([f.get("sf", fn), f.get("sf", fn)]);
  assert.equal(fills, 1);
  assert.deepEqual(
    all.map((h) => h.state),
    ["miss", "miss"],
  );
  assert.equal(all[0].res, all[1].res);
});

test("getMany: misses in chunks, one call each; hits and fills in flight not fetched again", async () => {
  const f = family();
  const calls: string[][] = [];
  const fetchMany = async (keys: string[]) => {
    calls.push(keys);
    await tick(2);
    return keys.map((k) => `v:${k}`);
  };
  await f.getMany(["a", "b"], fetchMany, { chunk: 20 });
  assert.deepEqual(calls, [["a", "b"]]);

  calls.length = 0;
  const keys = Array.from({ length: 45 }, (_, i) => `k${i}`);
  let charged = -1;
  const [hits, joined] = await Promise.all([
    f.getMany(["a", ...keys, "b"], fetchMany, {
      chunk: 20,
      beforeFill: (n) => (charged = n),
    }),
    // A second reader of a key being filled waits for that fill.
    tick(0).then(() => f.getMany(["k3"], fetchMany, { chunk: 20 })),
  ]);
  assert.equal(charged, 3);
  assert.deepEqual(
    calls.map((c) => c.length),
    [20, 20, 5],
  );
  assert.equal(hits.length, 47);
  assert.equal(hits[0].state, "hit");
  assert.equal(hits[46].state, "hit");
  assert.equal(JSON.parse(hits[10].res.json.toString()), "v:k9");
  assert.equal(joined[0].state, "miss");
  assert.equal(joined[0].res, hits[4].res, "the same fill");
  assert.equal(calls.length, 3);
});

test("getMany: a refused charge fetches nothing", async () => {
  const f = family();
  let fetched = false;
  await assert.rejects(
    f.getMany(
      ["x", "y"],
      async (keys) => {
        fetched = true;
        return keys;
      },
      {
        beforeFill: () => {
          throw new Error("429");
        },
      },
    ),
    /429/,
  );
  assert.equal(fetched, false);
  assert.equal((await f.get("x", async () => "x")).state, "miss");
});

test("value(): kept on the entry; parsed back from the JSON when a response filled it", async () => {
  const f = family();
  await f.response("list", async () => [{ id: 1 }]);
  const v = await f.value<{ id: number }[]>("list", async () => assert.fail("cached"));
  assert.deepEqual(v, [{ id: 1 }]);
  assert.equal(await f.value("list", async () => assert.fail("cached")), v, "parsed once");
  const own = { id: 2 };
  assert.equal(await f.value("own", async () => own), own);
  assert.equal(await f.value("own", async () => assert.fail("cached")), own);
});

test("the ETag follows the bytes, not the fill", async () => {
  const f = family({ ttlMs: 5 });
  const a = await f.get("e", async () => ({ n: 1 }));
  await tick(15);
  f.invalidate();
  const b = await f.get("e", async () => ({ n: 1 }));
  const c = await f.get("e2", async () => ({ n: 2 }));
  assert.equal(a.res.etag, b.res.etag);
  assert.notEqual(a.res.etag, c.res.etag);
});

test("ByteLru: bounded in bytes, least recently used out first", () => {
  const lru = new ByteLru<string>("test", 100, "external");
  lru.set("a", "A", 40);
  lru.set("b", "B", 40);
  assert.equal(lru.get("a"), "A");
  lru.set("c", "C", 40);
  assert.equal(lru.has("b"), false, "b was the least recently used");
  assert.equal(lru.bytes, 80);
  lru.set("huge", "H", 101);
  assert.equal(lru.has("huge"), false, "heavier than the budget: not kept");
  lru.set("a", "A2", 10);
  assert.equal(lru.bytes, 50);
  assert.deepEqual(lru.stats(), {
    name: "test",
    resident: "external",
    entries: 2,
    bytes: 50,
    maxBytes: 100,
    evictions: 1,
  });
});

test("getMany: a key asked twice is fetched once, answered twice", async () => {
  const f = family();
  const calls: string[][] = [];
  const hits = await f.getMany(
    ["a", "b", "a"],
    async (keys) => {
      calls.push(keys);
      return keys.map((k) => k.toUpperCase());
    },
    { chunk: 20 },
  );
  assert.deepEqual(calls, [["a", "b"]]);
  assert.deepEqual(
    hits.map((h) => JSON.parse(h.res.json.toString())),
    ["A", "B", "A"],
  );
});

test("every entry weighs its bytes and its overhead: tiny entries are bounded too", async () => {
  const f = family({ maxBytes: 10_000 });
  for (let i = 0; i < 200; i++) await f.get(`audition:${i}`, async () => null);
  const st = f.stats();
  assert.ok(st.entries < 40, `${st.entries} entries`);
  assert.ok(st.bytes <= 10_000);
});

test("getMany: a key's own failure fails that key alone; the rest of its chunk is kept", async () => {
  const f = family();
  class TooLarge extends Error {}
  const fetchMany = async (keys: string[]) =>
    keys.map((k) => (k === "huge" ? new KeyFailure(new TooLarge(k)) : `v:${k}`));
  await assert.rejects(f.getMany(["a", "huge", "b"], fetchMany, { chunk: 20 }), TooLarge);
  await tick(20); // the others' gzip, on the threadpool
  // A reader of "a" alone, then: kept by that call, not fetched again.
  const [a] = await f.getMany(["a"], async () => assert.fail("a was kept"));
  assert.equal(a.state, "hit");
  assert.equal(JSON.parse(a.res.json.toString()), "v:a");
  assert.equal((await f.get("b", async () => assert.fail("b was kept"))).state, "hit");
  // The failed key was not.
  assert.equal((await f.get("huge", async () => "now small")).state, "miss");
  assert.equal(f.stats().fills, 2, "one call for the chunk, one for the key asked again");
});

test("Prebuilt: a response its fill built, kept and served as is", async () => {
  const f = family();
  const json = Buffer.from('{"results":[1,2]}');
  const built = await responseOf(json, '"assembled"');
  const first = await f.get("batch", async () => new Prebuilt(built));
  assert.equal(first.state, "miss");
  assert.equal(first.res, built, "the very bytes");
  const again = await f.get("batch", async () => assert.fail("kept"));
  assert.equal(again.state, "hit");
  assert.equal(again.res, built);
  assert.equal(again.res.etag, '"assembled"');
  assert.equal(again.value, undefined);
  assert.ok(f.stats().bytes >= json.length + built.gz.length);
  // Without a tag of its own, the hash of the bytes (as for any value).
  assert.equal((await responseOf(json)).etag, (await buildResponse({ results: [1, 2] })).etag);
});

test("remembers: an error remembered for the TTL, the value held before not served past it", async () => {
  class TooLong extends Error {}
  const f = family({ ttlMs: 300, remembers: (e) => e instanceof TooLong });
  let fills = 0;
  let over = false;
  const fn = async () => {
    fills++;
    if (over) throw new TooLong("past the threshold");
    return "whole table";
  };
  await f.get("list", fn);
  over = true;
  await tick(320); // stale: served, and its refill behind the reply is refused
  assert.equal((await f.get("list", fn)).state, "stale");
  for (let i = 0; i < 200 && fills < 2; i++) await tick(5);
  await tick(5);
  assert.equal(fills, 2);
  await assert.rejects(f.get("list", fn), TooLong, "the stale value is not served past it");
  await assert.rejects(f.get("list", fn), TooLong);
  assert.equal(fills, 2, "remembered: not counted again per request");
  assert.equal(f.stats().entries, 0);
  assert.equal(f.stats().bytes, 0);
  // Past the TTL: asked again (still over, so refused and remembered again).
  await tick(320);
  await assert.rejects(f.get("list", fn), TooLong);
  assert.equal(fills, 3);
  // A write: asked again at once.
  f.invalidate();
  over = false;
  assert.equal((await f.get("list", fn)).state, "miss");
  assert.equal(fills, 4);
  // Any other error is not remembered.
  const g = family({ ttlMs: 300, remembers: (e) => e instanceof TooLong });
  let tries = 0;
  const flaky = async () => {
    tries++;
    throw new Error("boom");
  };
  await assert.rejects(g.get("k", flaky), /boom/);
  await assert.rejects(g.get("k", flaky), /boom/);
  assert.equal(tries, 2);
});

test("a refusal remembered while a write lands is not kept", async () => {
  class TooLong extends Error {}
  const f = family({ ttlMs: 60_000, remembers: (e) => e instanceof TooLong });
  let fail!: (e: Error) => void;
  const pending = f.get("list", () => new Promise((_, reject) => (fail = reject)));
  f.invalidate();
  fail(new TooLong("counted before the write"));
  await assert.rejects(pending, TooLong);
  assert.equal((await f.get("list", async () => "after the write")).state, "miss");
});

test("fetchMany is told a refill from a miss (a refill is nobody's to pay for)", async () => {
  const f = family({ ttlMs: 20 });
  const seen: boolean[] = [];
  const fetchMany = async (keys: string[], { refill }: { refill: boolean }) => {
    seen.push(refill);
    return keys.map((k) => k);
  };
  await f.getMany(["a"], fetchMany);
  await tick(30);
  assert.equal((await f.getMany(["a"], fetchMany))[0].state, "stale");
  for (let i = 0; i < 100 && seen.length < 2; i++) await tick(5);
  assert.deepEqual(seen, [false, true]);
  assert.equal(f.stats().fills, 2);
});
