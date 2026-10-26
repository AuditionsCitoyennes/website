import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { LocationGroup } from "@ac/shared";
import {
  FakeDb,
  FakeGeoApi,
  fakeEnv,
  fakeToken,
  installFakes,
  type Row,
} from "../../testing/fakes";

// The stored map's gates, over HTTP: MAP_SOURCE=db without the testing tools
// (no ?source=geocoder for visitors), the geocoder's build when the stored
// places cannot be read, the super admin's sweep, and a placement job that
// stays off unless PLACEMENT_JOB turns it on.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-place-routes-"));
fakeEnv(cacheDir, { MAP_SOURCE: "db" });
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

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const ADMIN = "00000000-0000-4000-8000-0000000000bb";
db.users = { [SUPER]: { email: "root@example.test" }, [ADMIN]: { email: "admin@example.test" } };
db.tables.user_roles = [
  { user_id: SUPER, role: "super_admin" },
  { user_id: ADMIN, role: "admin" },
];

const BUCKET = "00000000-0000-4000-8000-000000000001";
/** An online audition the old app renamed: stale, filed by its town hall meanwhile. */
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

let app: FastifyInstance;
let invalidatePublicCaches: () => void;
let forgetGeoUnits: () => void;
before(async () => {
  const { buildServer } = await import("../../server");
  ({ invalidatePublicCaches } = await import("../../lib/publicCache"));
  ({ forgetGeoUnits } = await import("./geoUnits"));
  app = buildServer();
  await app.ready();
});
after(async () => {
  await app.close();
  restore();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
beforeEach(() => {
  db.tables.auditions = [];
  db.tables.geo_units = [];
  db.tables.audition_testimony_counts = [
    { audition_id: BUCKET, total_count: 1, verified_count: 1 },
  ];
  db.insert("auditions", [bucket()]);
  db.requests = [];
  db.serviceKey = "service";
  db.refuse = () => null;
  invalidatePublicCaches();
  forgetGeoUnits();
});

const map = async (url = "/api/map") => {
  const res = await app.inject({ url });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as LocationGroup[];
};

test("without the testing tools, ?source=geocoder is the stored build all the same", async () => {
  const groups = await map("/api/map?source=geocoder");
  assert.equal(groups.length, 1);
  assert.ok("lieuId" in groups[0], "the stored build's shape");
  // geo_units is read once, not on every build.
  invalidatePublicCaches();
  await map();
  const unitReads = db.requests.filter((r) => r.url.pathname.endsWith("/geo_units"));
  assert.equal(unitReads.length, 1);
});

test("geo_units refused (a rotated key, the migration not there yet): the geocoder's build", async () => {
  db.serviceKey = "rotated";
  const groups = await map();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonicalName, "Mairie de Bron (69)");
  assert.equal("lieuId" in groups[0], false, "the geocoder's shape");

  const warnings: string[] = [];
  const log = { warn: (_obj: object, msg: string) => warnings.push(msg) };
  const { fetchAdminAuditions } = await import("../auditions/service");
  const { publicClient } = await import("../../lib/supabase");
  const list = await fetchAdminAuditions(publicClient, "db", log);
  assert.equal(list.kind, "ok");
  assert.equal(list.kind === "ok" && list.auditions[0].area.placement, "address");
  assert.match(warnings[0], /stored places not readable/);
});

test("an admin list over a database without the place columns: the geocoder's areas", async () => {
  db.refuse = (method, url) =>
    method === "GET" &&
    url.pathname.endsWith("/auditions") &&
    (url.searchParams.get("select") ?? "").includes("place_path")
      ? { status: 400, code: "42703", message: "column auditions.place_path does not exist" }
      : null;
  const { fetchAdminAuditions } = await import("../auditions/service");
  const { publicClient } = await import("../../lib/supabase");
  const list = await fetchAdminAuditions(publicClient, "db");
  assert.equal(list.kind, "ok");
  assert.equal(list.kind === "ok" && list.auditions.length, 1);
});

const sweep = (query: string, user?: string) =>
  app.inject({
    method: "POST",
    url: `/api/admin/places/sweep${query}`,
    headers: user ? { authorization: `Bearer ${fakeToken(user)}` } : {},
  });

test("the sweep: signed in, super admin only", async () => {
  assert.equal((await sweep("?dryRun=1")).statusCode, 401);
  assert.equal((await sweep("?dryRun=1", ADMIN)).statusCode, 403);
  assert.equal(db.tables.auditions[0].place_stale, true);
});

test("the sweep's dry run reports and writes nothing; the sweep then places", async () => {
  const dry = await sweep("?dryRun=1", SUPER);
  assert.equal(dry.statusCode, 200, dry.body);
  assert.equal(dry.json().dryRun, true);
  assert.equal(dry.json().placed, 1);
  assert.ok(!db.requests.some((r) => r.method !== "GET" && !r.url.pathname.includes("/rpc/")));
  assert.equal(db.tables.auditions[0].place_stale, true);
  assert.equal(db.tables.geo_units.length, 0);

  const real = await sweep("", SUPER);
  assert.equal(real.statusCode, 200, real.body);
  assert.equal(real.json().placed, 1);
  assert.equal(db.tables.auditions[0].place_stale, false);
  assert.equal(db.tables.auditions[0].place_unit, "fr:com:69029");
});

test("the placement job stays off unless PLACEMENT_JOB turns it on", async () => {
  const notes: string[] = [];
  const { startPlacementJob, nudgePlacementJob } = await import("./placementJob");
  startPlacementJob({
    info: (_obj, msg) => notes.push(msg),
    warn: (_obj, msg) => notes.push(msg),
    error: () => {},
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /placement job off: PLACEMENT_JOB/);
  db.requests = [];
  nudgePlacementJob();
  await new Promise((done) => setTimeout(done, 2200));
  assert.ok(!db.requests.some((r) => r.url.searchParams.get("place_stale") === "eq.true"));
  assert.equal(db.tables.auditions[0].place_stale, true);
});
