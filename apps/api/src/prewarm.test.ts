import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";

// The boot prewarm fills the auditions and the map, never the testimony
// corpus: a boot must not pull a table that grows with every testimony.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-prewarm-"));
Object.assign(process.env, {
  APP_ENV: "local",
  EMAIL_MODE: "log",
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_ANON_KEY: "anon",
  // As in CI, whatever a local apps/api/.env holds: the anon key's paths.
  SUPABASE_SERVICE_ROLE_KEY: "",
  LOG_LEVEL: "fatal",
  CACHE_DIR: cacheDir,
});

const paths: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  paths.push(new URL(input instanceof Request ? input.url : input).pathname);
  return Response.json([]);
}) as typeof fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await rm(cacheDir, { recursive: true, force: true });
});

test("prewarm reads the auditions and builds the map, not the corpus", async () => {
  const { prewarmPublicCaches } = await import("./prewarm");
  const { cached } = await import("./lib/cache");
  const { PUBLIC_CACHE_KEYS } = await import("./lib/publicCache");

  const warnings: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnings.push(args) } as unknown as FastifyBaseLogger;
  await prewarmPublicCaches(log);

  assert.deepEqual(warnings, []);
  assert.deepEqual([...new Set(paths)].sort(), [
    "/rest/v1/audition_testimony_counts",
    "/rest/v1/auditions",
  ]);

  // Filled: served without a read.
  const unexpected = async () => assert.fail("filled at boot, read again");
  await cached(PUBLIC_CACHE_KEYS.auditions, 60_000, unexpected);
  await cached(PUBLIC_CACHE_KEYS.map, 60_000, unexpected);
  // Not filled: the first request reads it.
  let corpusReads = 0;
  await cached(PUBLIC_CACHE_KEYS.testimonies, 60_000, async () => ++corpusReads);
  assert.equal(corpusReads, 1);
});
