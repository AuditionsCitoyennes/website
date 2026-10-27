import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { FakeDb, fakeEnv, installFakes } from "./testing/fakes";

// A load campaign's staging API (RATE_LIMITS=relaxed, emails logged): the
// online form's limit per visitor and the place reads' miss limit are 100
// times the usual; and /api/health?details=1 answers, staging being staging.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-relaxed-"));
fakeEnv(cacheDir, { APP_ENV: "staging", RATE_LIMITS: "relaxed" });
const db = new FakeDb();
db.rpcs.place_counts_many = (a) =>
  (a.p_units as string[]).map((unit) => ({ unit, units: [], lieux: [] }));
const restore = installFakes({ db });

let app: FastifyInstance;
before(async () => {
  const { buildServer } = await import("./server");
  app = buildServer();
  await app.ready();
});
after(async () => {
  await app.close();
  restore();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("the online form: more than its usual 5 tries an hour per visitor", async () => {
  for (let i = 0; i < 8; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/online-testimonies",
      payload: {},
      remoteAddress: "10.1.0.1",
    });
    // Refused for its empty form, never for the visitor's tries.
    assert.equal(res.statusCode, 400, `try ${i + 1}: ${res.body}`);
  }
});

test("the place reads: more than 30 misses per 10 s per visitor", async () => {
  for (let i = 0; i < 40; i++) {
    const res = await app.inject({
      url: `/api/places?unit=fr:com:${10000 + i}`,
      remoteAddress: "10.2.0.1",
    });
    assert.equal(res.statusCode, 200, `miss ${i + 1}: ${res.body}`);
  }
});

test("/api/health?details=1 on staging", async () => {
  const res = await app.inject({ url: "/api/health?details=1" });
  assert.ok(res.json().details.memoryMb.rss > 0);
});
