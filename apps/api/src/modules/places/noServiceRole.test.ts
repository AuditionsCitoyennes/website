import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { FakeDb, fakeEnv, fakeToken, installFakes } from "../../testing/fakes";

// Without the service role, geo_units cannot be read (server only): the map
// and the admin list are the geocoder's, whatever MAP_SOURCE says, and the
// placement job does not run.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-no-service-role-"));
fakeEnv(cacheDir, { SUPABASE_SERVICE_ROLE_KEY: "", MAP_SOURCE: "db", PLACEMENT_JOB: "true" });
const db = new FakeDb();
const restore = installFakes({ db });
after(async () => {
  restore();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("MAP_SOURCE=db without the service role: the geocoder's build, no job", async () => {
  const { mapSource } = await import("../../config");
  assert.equal(mapSource, "geocoder");

  db.tables.auditions = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      title: "A",
      date: "2026-05-01",
      location: "Mairie de Bron (69)",
      status: "published",
      audition_en_ligne: true,
      citycode: "69029",
      place: {
        insee: "69029",
        commune: "Bron",
        arrondissement: null,
        departementCode: "69",
        departementName: "Rhône",
        region: "Auvergne-Rhône-Alpes",
        lat: 45.7389,
        lng: 4.9132,
      },
    },
  ];
  db.tables.audition_testimony_counts = [
    { audition_id: "00000000-0000-4000-8000-000000000001", total_count: 1, verified_count: 1 },
  ];
  const { buildLocationGroups } = await import("../map/locationGroups");
  const groups = await buildLocationGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonicalName, "Mairie de Bron (69)");
  assert.equal("lieuId" in groups[0], false, "the geocoder's shape");
  assert.ok(!db.requests.some((r) => r.url.pathname.endsWith("/geo_units")));

  const warnings: string[] = [];
  const { startPlacementJob, nudgePlacementJob } = await import("./placementJob");
  startPlacementJob({
    info: () => {},
    warn: (_obj, msg) => warnings.push(msg),
    error: () => {},
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /placement job off/);
  nudgePlacementJob();
  await new Promise((done) => setTimeout(done, 2200));
  assert.ok(!db.requests.some((r) => r.url.searchParams.get("place_stale") === "eq.true"));
});

test("the sweep without the service role: 503, nothing placed", async () => {
  const SUPER = "00000000-0000-4000-8000-0000000000aa";
  db.users = { [SUPER]: { email: "root@example.test" } };
  db.rpcs.is_admin = () => true;
  db.rpcs.is_super_admin = () => true;
  const { buildServer } = await import("../../server");
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/places/sweep?dryRun=1",
      headers: { authorization: `Bearer ${fakeToken(SUPER)}` },
    });
    assert.equal(res.statusCode, 503, res.body);
  } finally {
    await app.close();
  }
});

test("the place reads without the service role: 503, never anon", async () => {
  const { buildServer } = await import("../../server");
  const app = buildServer();
  await app.ready();
  db.requests = [];
  try {
    for (const url of [
      "/api/places?unit=world",
      "/api/places?units=world,FR",
      "/api/places/lieu?id=l:0123456789abcdef",
      "/api/places/results",
      "/api/places/facets",
      "/api/auditions/00000000-0000-4000-8000-000000000001/testimonies",
    ]) {
      const res = await app.inject({ url });
      assert.equal(res.statusCode, 503, url);
      assert.equal(res.json().message, "Les lieux ne sont pas disponibles pour le moment.");
    }
    assert.ok(!db.requests.some((r) => r.url.pathname.includes("/rpc/")));
  } finally {
    await app.close();
  }
});

test("the boot prewarm without the service role: nothing asked", async () => {
  const { prewarmPublicCaches } = await import("../../prewarm");
  db.requests = [];
  const warnings: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnings.push(args) } as unknown as FastifyBaseLogger;
  await prewarmPublicCaches(log);
  assert.deepEqual(warnings, []);
  assert.deepEqual(db.requests, []);
});
