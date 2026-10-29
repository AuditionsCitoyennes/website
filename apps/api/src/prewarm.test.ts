import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { FakeDb, fakeEnv, installFakes, type Row } from "./testing/fakes";

// The boot prewarm fills what every first visit to the map waits on — the
// world with its figures, the filter dialog's facets and the home card's
// world (map phase 1) — under the keys the routes read, and nothing else:
// never a whole-table read (the auditions, the map, the testimony corpus).

const cacheDir = await mkdtemp(join(tmpdir(), "ac-prewarm-"));
fakeEnv(cacheDir);
const db = new FakeDb();
const restore = installFakes({ db });

const calls: { rpc: string; args: Row }[] = [];
db.rpcs.place_counts_many = (args) => {
  calls.push({ rpc: "place_counts_many", args });
  return (args.p_units as string[]).map((unit) => ({
    unit,
    complete: true,
    self: { n: 3, auditions: 1, rank: "2026-01-01", bbox: null },
    units: [],
    lieux: [],
  }));
};
db.rpcs.place_facets = (args) => {
  calls.push({ rpc: "place_facets", args });
  return { themes: [{ i: 0, n: 3 }], dates: ["2026-01-01", "2026-01-01"] };
};

after(async () => {
  restore();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("prewarm fills the world with its figures, the facets and the card's world, nothing else", async () => {
  const { prewarmPublicCaches } = await import("./prewarm");
  const warnings: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnings.push(args) } as unknown as FastifyBaseLogger;
  await prewarmPublicCaches(log);

  assert.deepEqual(warnings, []);
  // Three RPC calls, and not one table read (no whole-table pull, no count).
  assert.deepEqual(db.requests.map((r) => r.url.pathname).sort(), [
    "/rest/v1/rpc/place_counts_many",
    "/rest/v1/rpc/place_counts_many",
    "/rest/v1/rpc/place_facets",
  ]);
  const counts = calls.filter((c) => c.rpc === "place_counts_many").map((c) => c.args);
  const world = { p_units: ["world"], p_filters: {}, p_depth: 2, p_budget: 600 };
  assert.deepEqual(counts, [
    { ...world, p_facts: true, p_empty: false },
    { ...world, p_facts: false, p_empty: true },
  ]);

  // The page's first requests are hits: served without a call.
  const { buildServer } = await import("./server");
  const app = buildServer();
  await app.ready();
  try {
    for (const url of [
      "/api/places?unit=world&depth=2&facts=1",
      "/api/places/facets",
      "/api/places?unit=world&depth=2&empty=1",
    ]) {
      const res = await app.inject({ url });
      assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
      assert.equal(res.headers["x-cache"], "hit", url);
    }
    // Another read is not warmed: a miss.
    const other = await app.inject({ url: "/api/places?unit=world&depth=2" });
    assert.equal(other.headers["x-cache"], "miss");
  } finally {
    await app.close();
  }
  assert.equal(calls.length, 4);
  assert.ok(!db.requests.some((r) => !r.url.pathname.startsWith("/rest/v1/rpc/")), "no table read");
});
