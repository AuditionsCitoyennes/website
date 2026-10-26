import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FakeDb, fakeEnv, installFakes } from "../../testing/fakes";

// Without the service role, geo_units cannot be read (server only): the map
// and the admin list are the geocoder's, whatever MAP_SOURCE says, and the
// placement job does not run.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-no-service-role-"));
fakeEnv(cacheDir, { SUPABASE_SERVICE_ROLE_KEY: "", MAP_SOURCE: "db" });
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
