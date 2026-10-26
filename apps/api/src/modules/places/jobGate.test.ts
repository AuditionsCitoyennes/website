import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fakeEnv } from "../../testing/fakes";

// A developer's API (APP_ENV=local) pointed at a hosted database — the
// apps/api/.env of a checkout — never runs the placement job, even asked to:
// a mass write from a laptop is never what anyone meant.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-job-gate-"));
fakeEnv(cacheDir, {
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  MAP_SOURCE: "db",
  PLACEMENT_JOB: "true",
});
after(() => rm(cacheDir, { recursive: true, force: true }));

test("APP_ENV=local against a hosted database: the job stays off, with a warning", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    const warnings: string[] = [];
    const { startPlacementJob, nudgePlacementJob } = await import("./placementJob");
    startPlacementJob({
      info: () => {},
      warn: (_obj, msg) => warnings.push(msg),
      error: () => {},
    });
    assert.deepEqual(warnings, ["placement job off: APP_ENV=local against a hosted database"]);
    nudgePlacementJob();
    await new Promise((done) => setTimeout(done, 2200));
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
