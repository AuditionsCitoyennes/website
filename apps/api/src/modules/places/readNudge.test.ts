import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { FakeDb, FakeGeoApi, fakeEnv, installFakes, type Row } from "../../testing/fakes";

// The place reads nudge the placement job as /api/map does: a row the old
// app wrote (place_stale) is placed within seconds of the next read, not at
// the job's 10-minute round — and at most once a minute, whatever the reads.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-read-nudge-"));
fakeEnv(cacheDir, { MAP_SOURCE: "db", PLACEMENT_JOB: "true" });
const db = new FakeDb();
const geo = new FakeGeoApi();
const restore = installFakes({ db, geo });

geo.communes = {
  "69029": {
    code: "69029",
    nom: "Bron",
    departement: { code: "69", nom: "Rhône" },
    region: { code: "84", nom: "Auvergne-Rhône-Alpes" },
    centre: [45.7386, 4.9134],
    mairie: [45.7389, 4.9132],
  },
};

const BUCKET = "00000000-0000-4000-8000-000000000001";
/** An online audition the old app wrote: stale until the job places it. */
const bucket = (): Row => ({
  id: BUCKET,
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
});

db.rpcs.place_counts_many = (a) =>
  (a.p_units as string[]).map((unit) => ({ unit, complete: true, units: [], lieux: [] }));
db.rpcs.audition_results = () => ({ auditions: [], next: null });

let app: FastifyInstance;
before(async () => {
  db.tables.audition_testimony_counts = [
    { audition_id: BUCKET, total_count: 1, verified_count: 1 },
  ];
  db.insert("auditions", [bucket()]);
  const { buildServer } = await import("../../server");
  app = buildServer();
  await app.ready();
});
after(async () => {
  await app.close();
  restore();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Whether a pass read the stale rows since the last reset of the requests. */
const passRan = () => db.requests.some((r) => r.url.searchParams.get("place_stale") === "eq.true");

test("a place read nudges the placement job: the old app's row placed within seconds", async () => {
  const { startPlacementJob } = await import("./placementJob");
  const notes: string[] = [];
  startPlacementJob({
    info: (_obj, msg) => notes.push(msg),
    warn: (_obj, msg) => notes.push(msg),
    error: (_obj, msg) => notes.push(msg),
  });
  assert.deepEqual(notes, [], "the job runs here");
  assert.equal(db.tables.auditions[0].place_stale, true);

  // Its first round is 10 s after boot: any pass sooner is the read's.
  db.requests = [];
  const read = await app.inject({ url: "/api/places?unit=FR" });
  assert.equal(read.statusCode, 200, read.body);
  for (let i = 0; i < 60 && db.tables.auditions[0].place_stale; i++) await sleep(100);
  assert.ok(passRan(), "a pass ran");
  assert.equal(db.tables.auditions[0].place_stale, false, "placed");
  assert.equal(db.tables.auditions[0].place_unit, "fr:com:69029");

  // At most once a minute: another row written the old way, read again at once, waits its turn.
  await sleep(100);
  db.tables.auditions[0].place_stale = true;
  db.requests = [];
  assert.equal((await app.inject({ url: "/api/places/results" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/places?unit=world" })).statusCode, 200);
  await sleep(2500);
  assert.equal(passRan(), false, "no second pass within the minute");
  assert.equal(db.tables.auditions[0].place_stale, true);
});
