import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LocationGroup } from "@ac/shared";
import { FakeDb, fakeEnv, installFakes } from "../../testing/fakes";

// MAP_SOURCE unset, with the service role: the geocoder's build, and no
// placement job. Production does not set it and keeps the geocoder's map until
// its cutover, so the default must stay "geocoder" (and PLACEMENT_JOB's "false").

const cacheDir = await mkdtemp(join(tmpdir(), "ac-map-source-default-"));
fakeEnv(cacheDir, {
  // Unset for real: dotenv must not fill them in from a local apps/api/.env.
  DOTENV_CONFIG_PATH: join(cacheDir, "no.env"),
});
delete process.env.MAP_SOURCE;
delete process.env.PLACEMENT_JOB;
const db = new FakeDb();
const restore = installFakes({ db });
after(async () => {
  restore();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("MAP_SOURCE unset, with the service role: the geocoder's build, no job", async () => {
  const { config, hasServiceRole, mapSource } = await import("../../config");
  assert.equal(hasServiceRole, true);
  assert.equal(config.MAP_SOURCE, "geocoder");
  assert.equal(mapSource, "geocoder");
  assert.equal(config.PLACEMENT_JOB, false);

  const ID = "00000000-0000-4000-8000-000000000001";
  db.tables.auditions = [
    {
      id: ID,
      title: "Audition en ligne de mai",
      date: "2026-05-01",
      location: "Mairie de Bron (69)",
      content: "",
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
      created_at: "2026-05-01T10:00:00.000Z",
    },
  ];
  db.tables.audition_testimony_counts = [{ audition_id: ID, total_count: 1, verified_count: 1 }];

  const { buildServer } = await import("../../server");
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ url: "/api/map" });
    assert.equal(res.statusCode, 200, res.body);
    const groups = res.json() as LocationGroup[];
    assert.equal(groups.length, 1);
    assert.equal(groups[0].canonicalName, "Mairie de Bron (69)");
    assert.equal("lieuId" in groups[0], false, "the geocoder's shape");
    assert.ok(!db.requests.some((r) => r.url.pathname.endsWith("/geo_units")));
  } finally {
    await app.close();
  }
});
