import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { FakeBan, FakeDb, FakeGeoApi, fakeEnv, fakeToken, installFakes } from "../../testing/fakes";

// A volunteer who types in testimonies certifies, once per submission, that
// every witness agreed to be published: the audition builder
// (POST /api/auditions) and the « Ajouter un témoignage » dialog
// (POST /api/testimonies) are refused without it, and each testimony created
// keeps who certified and when.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-consent-certified-"));
fakeEnv(cacheDir);
const db = new FakeDb();
const restore = installFakes({ db, ban: new FakeBan(), geo: new FakeGeoApi() });

const ADMIN = "00000000-0000-4000-8000-0000000000bb";
db.users = { [ADMIN]: { email: "admin@example.test" } };
db.tables.user_roles = [{ user_id: ADMIN, role: "admin" }];
db.rpcs.insert_audit_log = () => null;

const AUDITION = "00000000-0000-4000-8000-000000000001";
const testimony = { person_name: "Camille", content: "Ce que j'ai dit à l'audition." };

let app: FastifyInstance;
before(async () => {
  const { buildServer } = await import("../../server");
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
  db.tables.testimonies = [];
  db.insert("auditions", [
    {
      id: AUDITION,
      title: "Audition du marché",
      date: "2026-10-31",
      location: "Villeurbanne",
      content: "",
      status: "published",
    },
  ]);
});

const post = (url: string, payload: object) =>
  app.inject({
    method: "POST",
    url,
    payload,
    headers: { authorization: `Bearer ${fakeToken(ADMIN)}` },
  });

const newAudition = (extra: object) => ({
  title: "Audition de la place",
  date: "2026-11-01",
  location: "Rue Racine, Villeurbanne",
  place: { kind: "ban", citycode: "69266", lat: 45.769, lng: 4.88, type: "street" },
  content: "Sur la place du marché.",
  ...extra,
});

test("a testimony sent without the certification is refused, and nothing is written", async () => {
  for (const consent of [{}, { consent_certified: false }]) {
    const res = await post("/api/testimonies", { audition_id: AUDITION, ...testimony, ...consent });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().message, /Cochez la case/);
  }
  assert.equal(db.tables.testimonies.length, 0);
});

test("a certified testimony keeps who certified and when", async () => {
  const sent = Date.now();
  const res = await post("/api/testimonies", {
    audition_id: AUDITION,
    ...testimony,
    consent_certified: true,
  });
  assert.equal(res.statusCode, 201, res.body);
  const [row] = db.tables.testimonies;
  assert.equal(row.consent_certified_by, ADMIN);
  assert.ok(Date.parse(String(row.consent_certified_at)) >= sent - 1000);
});

test("an audition sent with testimonies but without the certification is refused, and nothing is written", async () => {
  const res = await post("/api/auditions", newAudition({ testimonies: [testimony] }));
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().message, /Cochez la case/);
  assert.equal(db.tables.auditions.length, 1, "only the fixture's");
  assert.equal(db.tables.testimonies.length, 0);
});

test("a certified audition stamps each of its testimonies", async () => {
  const res = await post(
    "/api/auditions",
    newAudition({
      testimonies: [testimony, { person_name: "Anonyme", content: "Un autre." }],
      consent_certified: true,
    }),
  );
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(db.tables.testimonies.length, 2);
  for (const row of db.tables.testimonies) {
    assert.equal(row.consent_certified_by, ADMIN);
    assert.ok(row.consent_certified_at);
  }
});

test("an audition sent without testimonies needs no certification", async () => {
  const res = await post("/api/auditions", newAudition({}));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(db.tables.auditions.length, 2);
});
