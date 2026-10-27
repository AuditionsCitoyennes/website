import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { FakeDb, fakeEnv, installFakes } from "./testing/fakes";

// In production (no testing tools), /api/health says it is up and nothing
// more: no memory details, not the caller's address.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-production-health-"));
fakeEnv(cacheDir, { APP_ENV: "production" });
const restore = installFakes({ db: new FakeDb() });

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

test("/api/health?details=1 in production: no details", async () => {
  for (const url of ["/api/health?details=1", "/health?details=1"]) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.details, undefined, url);
    assert.equal(body.ip, undefined, url);
  }
});
