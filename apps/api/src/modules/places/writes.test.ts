import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { PRECISE_ADDRESS_REQUIRED } from "@ac/shared";
import {
  FakeBan,
  FakeDb,
  FakeGeoApi,
  fakeEnv,
  fakeToken,
  installFakes,
  type FakeCommune,
  type Row,
} from "../../testing/fakes";

// Where an audition is placed when it is written: a visitor's online
// testimony (its town hall's place goes to submit_online_testimony), and an
// admin's creation or edit (placed within 3 s, an address picked from the
// BAN suggestions winning; else stored stale for the placement job).

const cacheDir = await mkdtemp(join(tmpdir(), "ac-place-writes-"));
fakeEnv(cacheDir);
const db = new FakeDb();
const ban = new FakeBan();
const geo = new FakeGeoApi();
const restore = installFakes({ db, ban, geo });

const RHONE = { code: "69", nom: "Rhône" };
const ARA = { code: "84", nom: "Auvergne-Rhône-Alpes" };
const commune = (
  code: string,
  nom: string,
  centre: [number, number],
  extra: Partial<FakeCommune> = {},
): FakeCommune => ({ code, nom, departement: RHONE, region: ARA, centre, ...extra });
geo.communes = {
  "69266": commune("69266", "Villeurbanne", [45.7707, 4.8846], { mairie: [45.7667, 4.8796] }),
  "69029": commune("69029", "Bron", [45.7386, 4.9134], { mairie: [45.7389, 4.9132] }),
  // No town hall point in geo.api: its centre.
  "69091": commune("69091", "Givors", [45.59, 4.769]),
  "69381": commune("69381", "Lyon 1er Arrondissement", [45.767, 4.834], {
    type: "arrondissement-municipal",
    codeParent: "69123",
    mairie: [45.7676, 4.8351],
  }),
};
const RHONE_CTX = "69, Rhône, Auvergne-Rhône-Alpes";
ban.municipality = {
  Bron: [
    {
      name: "Bron",
      citycode: "69029",
      context: RHONE_CTX,
      coords: [45.7386, 4.9134],
      type: "municipality",
    },
  ],
  Villeurbanne: [
    {
      name: "Villeurbanne",
      citycode: "69266",
      context: RHONE_CTX,
      coords: [45.7707, 4.8846],
      type: "municipality",
    },
  ],
};
ban.reverse = { "45.7387,4.9127": { citycode: "69029", context: RHONE_CTX, city: "Bron" } };

// submit_online_testimony, as far as its bucket goes.
const rpcCalls: Row[] = [];
db.rpcs.submit_online_testimony = (args) => {
  rpcCalls.push(args);
  let bucket = db.tables.auditions.find(
    (a) => a.audition_en_ligne && a.citycode === args.p_citycode && a.date === args.p_month,
  );
  const created = !bucket;
  bucket ??= db.insert("auditions", [
    {
      title: args.p_title,
      date: args.p_month,
      location: args.p_location,
      content: args.p_audition_content,
      status: "published",
      audition_en_ligne: true,
      citycode: args.p_citycode,
      place: args.p_place,
    },
  ])[0];
  const placed =
    args.p_place_unit && args.p_place_path && args.p_place_precision && args.p_lat && args.p_lng;
  if (placed && !bucket.place_path) {
    Object.assign(bucket, {
      place_unit: args.p_place_unit,
      place_path: args.p_place_path,
      locality_id: args.p_locality_id ?? null,
      lieu_key: bucket.location,
      lat: args.p_lat,
      lng: args.p_lng,
      place_precision: args.p_place_precision,
      placed_location: bucket.location,
      geo_release: args.p_geo_release ?? null,
      place_stale: false,
    });
  }
  return { testimony_id: crypto.randomUUID(), audition_id: bucket.id, audition_created: created };
};
db.rpcs.insert_audit_log = () => null;
db.tables.testimonies = [];

// The admin behind the form's requests.
const ADMIN = "00000000-0000-4000-8000-0000000000bb";
db.users = { [ADMIN]: { email: "admin@example.test" } };
db.tables.user_roles = [{ user_id: ADMIN, role: "admin" }];

let app: FastifyInstance;
let auditions: typeof import("../auditions/service");
let publicClient: typeof import("../../lib/supabase").publicClient;
const log = {
  warn: () => {},
  error: () => {},
  info: () => {},
} as unknown as FastifyBaseLogger;

before(async () => {
  const { buildServer } = await import("../../server");
  auditions = await import("../auditions/service");
  ({ publicClient } = await import("../../lib/supabase"));
  app = buildServer();
  await app.ready();
});
after(async () => {
  await app.close();
  restore();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
beforeEach(async () => {
  db.tables.auditions = [];
  db.tables.geo_units = [];
  db.requests = [];
  db.beforeAnswer = () => {};
  db.refuse = () => null;
  rpcCalls.length = 0;
  ban.calls = [];
  const { forgetGeoUnits } = await import("./geoUnits");
  forgetGeoUnits();
});

const form = (place: Row) => ({
  ...place,
  email: "temoin@example.test",
  person_name: "Camille",
  answers: [] as string[],
  consent: true,
  elapsed_ms: 60_000,
});

let visitor = 0;
async function submit(place: Row) {
  const { AUDITION_QUESTIONS } = await import("@ac/shared");
  const body = form(place);
  body.answers = AUDITION_QUESTIONS.map((_, i) => (i === 0 ? "Une réponse." : ""));
  // A visitor each: the form takes a few an hour from one address.
  return app.inject({
    method: "POST",
    url: "/api/online-testimonies",
    payload: body,
    remoteAddress: `10.0.0.${++visitor}`,
  });
}

test("an online testimony files its bucket placed: the town hall's units and point", async () => {
  const res = await submit({ place: { country: "FR", commune_code: "69266" } });
  assert.equal(res.statusCode, 201, res.body);
  const args = rpcCalls[0];
  assert.equal(args.p_citycode, "69266");
  assert.equal(args.p_place_unit, "fr:com:69266");
  assert.deepEqual(args.p_place_path, ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69266"]);
  assert.equal(args.p_locality_id, "fr:com:69266");
  assert.deepEqual([args.p_lat, args.p_lng], [45.7667, 4.8796]);
  assert.equal(args.p_place_precision, "address", "the town hall's own point");
  assert.equal(args.p_geo_release, "geoapi-2026");
  // Its units first.
  assert.deepEqual(
    db.tables.geo_units.map((u) => u.id),
    ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69266"],
  );
  const bucket = db.tables.auditions[0];
  assert.equal(bucket.place_stale, false);
  assert.equal(bucket.lieu_key, "Mairie de Villeurbanne (69)");
});

test("the bare commune_code still works; a commune's centre is precision commune; an arrondissement sits under its city", async () => {
  const centre = await submit({ commune_code: "69091" });
  assert.equal(centre.statusCode, 201, centre.body);
  assert.equal(rpcCalls[0].p_place_precision, "commune");
  assert.deepEqual([rpcCalls[0].p_lat, rpcCalls[0].p_lng], [45.59, 4.769]);

  const lyon = await submit({ place: { country: "FR", commune_code: "69381" } });
  assert.equal(lyon.statusCode, 201, lyon.body);
  assert.deepEqual(rpcCalls[1].p_place_path, [
    "FR",
    "fr:reg:84",
    "fr:dep:69",
    "fr:com:69123",
    "fr:com:69381",
  ]);
  assert.equal(rpcCalls[1].p_locality_id, "fr:com:69123");
});

test("units that cannot be written: the testimony is filed all the same, its bucket stale", async () => {
  const realInsert = db.insert.bind(db);
  db.insert = (table, rows, opts) => {
    if (table === "geo_units") throw new Error("geo_units down");
    return realInsert(table, rows, opts);
  };
  try {
    const res = await submit({ commune_code: "69029" });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(rpcCalls[0].p_place_unit, undefined);
    assert.equal(db.tables.auditions[0].place_stale, true);
  } finally {
    db.insert = realInsert;
  }
});

test("a database whose function takes no place yet: the testimony is filed, its bucket stale", async () => {
  db.refuse = (method, url, body) =>
    url.pathname.endsWith("/rpc/submit_online_testimony") &&
    (body as Row | undefined)?.p_place_unit !== undefined
      ? {
          status: 404,
          code: "PGRST202",
          message: "Could not find the function public.submit_online_testimony(...)",
        }
      : null;
  const res = await submit({ commune_code: "69266" });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(rpcCalls.length, 1, "answered on the second call");
  assert.equal(rpcCalls[0].p_place_unit, undefined);
  assert.equal(db.tables.auditions[0].place_stale, true);
});

test("the online form refuses a place without a commune, and a place abroad (for now)", async () => {
  const none = await submit({});
  assert.equal(none.statusCode, 400);
  assert.match(none.json().message, /Choisissez votre commune/);
  const abroad = await submit({ place: { country: "DE", commune_code: "69266" } });
  assert.equal(abroad.statusCode, 400);
  assert.equal(rpcCalls.length, 0);
});

// Service-level calls past the schema: a text without a pick still reaches
// placeBriefly and placeRefused through a refused pick or a stale old row.
const input = (location: string, extra: Row = {}) =>
  ({
    title: "Audition",
    date: "2026-05-01",
    content: "",
    status: "published",
    location,
    testimonies: [],
    ...extra,
  }) as never;

// The admin form's requests, through the routes and their schemas.
const asAdmin = { authorization: `Bearer ${fakeToken(ADMIN)}` };
const post = (payload: object) =>
  app.inject({ method: "POST", url: "/api/auditions", payload, headers: asAdmin });
const patch = (id: unknown, payload: object) =>
  app.inject({ method: "PATCH", url: `/api/auditions/${id}`, payload, headers: asAdmin });
const body = (location: string, extra: object = {}) => ({
  title: "Audition",
  date: "2026-05-01",
  location,
  ...extra,
});
const VILLEURBANNE_STREET = {
  kind: "ban",
  citycode: "69266",
  lat: 45.769,
  lng: 4.88,
  type: "street",
} as const;
const VILLEURBANNE_TOWN = {
  kind: "ban",
  citycode: "69266",
  lat: 45.7707,
  lng: 4.8846,
  type: "municipality",
};

/** Records a refusal's footprint: what reached the database and the geocoders. */
function watchWrites() {
  db.requests = [];
  const units = structuredClone(db.tables.geo_units);
  const banCalls = ban.calls.length;
  const geoCalls = geo.calls.length;
  return () => {
    const writes = db.requests.filter((r) => r.method !== "GET");
    assert.deepEqual(writes, [], "nothing written");
    assert.deepEqual(db.tables.geo_units, units);
    assert.equal(ban.calls.length, banCalls);
    assert.equal(geo.calls.length, geoCalls);
  };
}

test("a pick a curated lieu claims is placed by its rule", async () => {
  // "bron" is a curated keyword (LOCATION_RULES): its rule wins over the pick.
  const place = { kind: "ban", citycode: "69029", lat: 45.7387, lng: 4.9127, type: "street" };
  const res = await post(body("bron", { place }));
  assert.equal(res.statusCode, 201, res.body);
  const row = db.tables.auditions[0];
  assert.equal(row.location, "Bron");
  assert.equal(row.lieu_key, "Parvis Médiathèque, Bron");
  assert.equal(row.place_unit, "fr:com:69029");
  assert.equal(row.place_stale, false);
});

test("an in-person creation without a picked address is refused", async () => {
  const nothingWritten = watchWrites();
  const res = await post(body("Bron"));
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().message, PRECISE_ADDRESS_REQUIRED);
  assert.equal(db.tables.auditions.length, 0);
  nothingWritten();
  assert.deepEqual(ban.calls, []);
});

test("a commune picked as a whole is refused", async () => {
  const nothingWritten = watchWrites();
  const res = await post(body("Villeurbanne", { place: VILLEURBANNE_TOWN }));
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().message, PRECISE_ADDRESS_REQUIRED);
  assert.equal(db.tables.auditions.length, 0);
  nothingWritten();
});

test("a street picked from the suggestions is created at the pick", async () => {
  const street = await post(body("Rue Racine, Villeurbanne", { place: VILLEURBANNE_STREET }));
  assert.equal(street.statusCode, 201, street.body);
  const row = db.tables.auditions[0];
  assert.equal(row.place_precision, "address");
  assert.deepEqual([row.lat, row.lng], [45.769, 4.88]);
  assert.equal(row.place_unit, "fr:com:69266");
  assert.equal(row.lieu_key, row.location);

  const place = { kind: "ban", citycode: "69266", lat: 45.7752, lng: 4.8781, type: "locality" };
  const square = await post(body("Square Gendron, Villeurbanne", { place }));
  assert.equal(square.statusCode, 201, square.body);
  const lieuDit = db.tables.auditions[1];
  assert.equal(lieuDit.place_precision, "address");
  assert.deepEqual([lieuDit.lat, lieuDit.lng], [45.7752, 4.8781]);
  assert.equal(lieuDit.place_unit, "fr:com:69266");
  assert.equal(lieuDit.lieu_key, lieuDit.location);
  assert.deepEqual(ban.calls, [], "no geocoder");
});

test("an in-person move without a pick is refused, the row untouched", async () => {
  const created = await post(body("Rue Racine, Villeurbanne", { place: VILLEURBANNE_STREET }));
  assert.equal(created.statusCode, 201, created.body);
  const row = db.tables.auditions[0];
  const was = structuredClone(row);
  const nothingWritten = watchWrites();
  const res = await patch(row.id, { title: "X", location: "Bron" });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().message, PRECISE_ADDRESS_REQUIRED);
  assert.deepEqual(row, was);
  nothingWritten();
});

test("an edit: a commune pick is refused, a street pick moves it", async () => {
  const created = await post(body("Rue Racine, Villeurbanne", { place: VILLEURBANNE_STREET }));
  assert.equal(created.statusCode, 201, created.body);
  const row = db.tables.auditions[0];
  const was = structuredClone(row);
  const nothingWritten = watchWrites();
  const town = await patch(row.id, { location: "Villeurbanne", place: VILLEURBANNE_TOWN });
  assert.equal(town.statusCode, 400, town.body);
  assert.equal(town.json().message, PRECISE_ADDRESS_REQUIRED);
  assert.deepEqual(row, was);
  nothingWritten();

  const place = { kind: "ban", citycode: "69266", lat: 45.7731, lng: 4.8862, type: "street" };
  const moved = await patch(row.id, { location: "Rue Léon Blum, Villeurbanne", place });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.deepEqual([row.lat, row.lng], [45.7731, 4.8862]);
  assert.equal(row.place_unit, "fr:com:69266");
  assert.equal(row.place_precision, "address");
  assert.equal(row.lieu_key, row.location);
  assert.deepEqual(ban.calls, []);
});

test("an old row's save that keeps its text is accepted, and placed again from its text as today", async () => {
  db.insert("geo_units", [
    { id: "FR", parent_id: null, level: "country", country: "FR", name: "France" },
    { id: "fr:reg:84", parent_id: "FR", level: "region", country: "FR", name: ARA.nom },
    { id: "fr:dep:69", parent_id: "fr:reg:84", level: "county", country: "FR", name: RHONE.nom },
  ]);
  const [old] = db.insert("auditions", [
    {
      title: "Audition",
      date: "2026-05-01",
      location: "place du marché, bron",
      content: "",
      status: "published",
      audition_en_ligne: false,
      place_unit: "fr:dep:69",
      place_path: ["FR", "fr:reg:84", "fr:dep:69"],
      lieu_key: "place du marché, bron",
      lat: 45.87,
      lng: 4.64,
      place_precision: "departement",
      placed_location: "place du marché, bron",
    },
  ]);
  const res = await patch(old.id, { title: "Renamed", location: "place du marché, bron" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(old.title, "Renamed");
  assert.equal(old.location, "Place Du Marché, Bron");
  // The curated Bron rule's place, as an old row's save gets it today.
  assert.equal(old.lieu_key, "Parvis Médiathèque, Bron");
  assert.equal(old.place_unit, "fr:com:69029");
  assert.equal(old.place_stale, false);
  assert.deepEqual([old.lat, old.lng], [45.7387, 4.9127]);
  assert.equal(old.place_precision, "address");
});

test("an online audition's edit without a pick is as today", async () => {
  const [bucket] = db.insert("auditions", [
    {
      title: "Audition en ligne de mai",
      date: "2026-05-01",
      location: "Mairie de Bron (69)",
      content: "",
      status: "published",
      audition_en_ligne: true,
      citycode: "69029",
      place: { insee: "69029", lat: 45.7389, lng: 4.9132 },
    },
  ]);
  const res = await patch(bucket.id, { title: "T", location: "Ailleurs" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(bucket.title, "T");
  assert.equal(bucket.location, "Mairie de Bron (69)");
});

test("an admin creation with a BAN pick is stored at the pick, no geocoder call", async () => {
  const place = { kind: "ban", citycode: "69266", lat: 45.7712, lng: 4.8902, type: "housenumber" };
  const r = await auditions.createAudition(
    publicClient,
    log,
    "u1",
    input("12 Rue Paul Verlaine, Villeurbanne", { place }),
  );
  assert.equal(r.kind, "ok");
  const row = db.tables.auditions[0];
  assert.equal(row.place_unit, "fr:com:69266");
  assert.deepEqual([row.lat, row.lng], [45.7712, 4.8902]);
  assert.equal(row.place_precision, "address");
  assert.equal(row.lieu_key, "12 Rue Paul Verlaine, Villeurbanne");
  assert.deepEqual(ban.calls, []);
});

test("a geocoder slower than 3 s: the audition is stored stale, for the job", async () => {
  ban.municipality["Lent"] = [];
  const realAnswer = ban.answer.bind(ban);
  ban.answer = (url) => {
    if (url.searchParams.get("q") === "Lent") {
      return new Promise<Response>((done) =>
        setTimeout(() => done(realAnswer(url)), 4000),
      ) as never;
    }
    return realAnswer(url);
  };
  try {
    const started = Date.now();
    const r = await auditions.createAudition(publicClient, log, "u1", input("Lent"));
    assert.equal(r.kind, "ok");
    assert.ok(Date.now() - started < 3800, "not held past the budget");
    const row = db.tables.auditions[0];
    assert.equal(row.place_stale, true);
    assert.equal(row.place_path ?? null, null);
  } finally {
    ban.answer = realAnswer;
  }
});

test("an admin edit re-places on a move, a pick or a stale row — and only then", async () => {
  await auditions.createAudition(publicClient, log, "u1", input("Villeurbanne"));
  const row = db.tables.auditions[0];
  const id = String(row.id);
  assert.equal(row.place_unit, "fr:com:69266");

  // Same location, placed: no placement work.
  ban.calls = [];
  const geoCalls = geo.calls.length;
  await auditions.updateAudition(publicClient, log, "u1", id, {
    title: "Renamed",
    location: "Villeurbanne",
  });
  assert.deepEqual(ban.calls, []);
  assert.equal(geo.calls.length, geoCalls);
  assert.equal(row.title, "Renamed");

  // Moved without a pick: refused, the row as it was.
  const was = structuredClone(row);
  const refused = await auditions.updateAudition(publicClient, log, "u1", id, {
    location: "bron",
  });
  assert.deepEqual(refused, { kind: "needsAddress" });
  assert.deepEqual(row, was);

  // Moved with a pick: placed where it now is, in the same write.
  const givors = {
    kind: "ban",
    citycode: "69091",
    lat: 45.591,
    lng: 4.77,
    type: "street",
  } as const;
  await auditions.updateAudition(publicClient, log, "u1", id, {
    location: "Rue Jean Jaurès, Givors",
    place: givors,
  });
  assert.equal(row.location, "Rue Jean Jaurès, Givors");
  assert.equal(row.place_unit, "fr:com:69091");
  assert.deepEqual([row.lat, row.lng], [45.591, 4.77]);
  assert.equal(row.lieu_key, row.location);
  assert.equal(row.place_stale, false);
  assert.deepEqual(ban.calls, []);

  // A pick: placed at the pick.
  const place = { kind: "ban", citycode: "69266", lat: 45.769, lng: 4.88, type: "street" } as const;
  await auditions.updateAudition(publicClient, log, "u1", id, {
    location: "Rue Racine, Villeurbanne",
    place,
  });
  assert.deepEqual([row.lat, row.lng], [45.769, 4.88]);
  assert.equal(row.lieu_key, "Rue Racine, Villeurbanne");
  assert.equal(row.place_unit, "fr:com:69266");
  // The same text picked again elsewhere in the commune: the new pick.
  await auditions.updateAudition(publicClient, log, "u1", id, {
    location: "Rue Racine, Villeurbanne",
    place: { ...place, lat: 45.7695, lng: 4.8805 },
  });
  assert.deepEqual([row.lat, row.lng], [45.7695, 4.8805]);

  // Made stale by the old app: the next save, which sends the same
  // location (the form sends every field), places it.
  row.location = "Villeurbanne";
  row.place_stale = true;
  await auditions.updateAudition(publicClient, log, "u1", id, {
    title: "Again",
    location: "Villeurbanne",
  });
  assert.equal(row.place_unit, "fr:com:69266");
  assert.equal(row.place_stale, false);
});

test("an edit that sends no location leaves a placed audition's place alone", async () => {
  const place = { kind: "ban", citycode: "69266", lat: 45.769, lng: 4.88, type: "street" } as const;
  await auditions.createAudition(
    publicClient,
    log,
    "u1",
    input("Rue Racine, Villeurbanne", { place }),
  );
  const row = db.tables.auditions[0];
  db.requests = [];
  ban.calls = [];
  await auditions.updateAudition(publicClient, log, "u1", String(row.id), { title: "Renamed" });
  assert.equal(row.title, "Renamed");
  assert.deepEqual([row.lat, row.lng], [45.769, 4.88], "still at its pick");
  const auditionCalls = db.requests.filter((r) => r.url.pathname.endsWith("/auditions"));
  assert.deepEqual(
    auditionCalls.map((r) => r.method),
    ["GET", "PATCH"],
    "its read, its write: no lookup of another lieu, no place write",
  );
  assert.ok(!auditionCalls.some((r) => r.url.searchParams.has("lieu_key")));
  assert.deepEqual(ban.calls, []);
});

test("an edit of a lieu placed abroad, without a new pick, keeps its place; only its name follows", async () => {
  db.insert("geo_units", [
    { id: "DE", parent_id: null, level: "country", country: "DE", name: "Allemagne" },
  ]);
  const [berlin] = db.insert("auditions", [
    {
      title: "Audition",
      date: "2026-05-01",
      location: "Berlin",
      content: "",
      status: "published",
      audition_en_ligne: false,
      place_unit: "DE",
      place_path: ["DE"],
      lieu_key: "Berlin",
      lat: 52.52,
      lng: 13.4,
      place_precision: "locality",
      placed_location: "Berlin",
    },
  ]);
  await auditions.updateAudition(publicClient, log, "u1", String(berlin.id), {
    location: "berlin mitte",
  });
  assert.equal(berlin.location, "Berlin Mitte");
  assert.equal(berlin.place_unit, "DE");
  assert.deepEqual([berlin.lat, berlin.lng], [52.52, 13.4]);
  assert.equal(berlin.lieu_key, "Berlin Mitte");
  assert.equal(berlin.place_stale, false);
  assert.deepEqual(ban.calls, [], "never the geocoder");
});

test("a place the table refuses: the audition is stored all the same, stale", async () => {
  // The units vanish between their upsert and the audition's write (a reset).
  db.beforeAnswer = (method, url) => {
    if ((method === "POST" || method === "PATCH") && url.pathname.endsWith("/auditions")) {
      db.tables.geo_units = [];
    }
  };
  const created = await auditions.createAudition(publicClient, log, "u1", input("Villeurbanne"));
  assert.equal(created.kind, "ok");
  const row = db.tables.auditions[0];
  assert.equal(row.place_stale, true);
  assert.equal(row.place_unit ?? null, null);

  const { forgetGeoUnits } = await import("./geoUnits");
  forgetGeoUnits();
  const updated = await auditions.updateAudition(publicClient, log, "u1", String(row.id), {
    title: "Renamed",
    location: "Rue Jean Jaurès, Givors",
    place: { kind: "ban", citycode: "69091", lat: 45.591, lng: 4.77, type: "street" },
  });
  assert.equal(updated.kind, "ok");
  assert.equal(row.location, "Rue Jean Jaurès, Givors");
  assert.equal(row.title, "Renamed");
  assert.equal(row.place_stale, true);
});

test("a database without the place columns yet: the audition is stored, stale", async () => {
  db.refuse = (method, url, body) =>
    method === "POST" &&
    url.pathname.endsWith("/auditions") &&
    (body as Row | undefined)?.place_unit !== undefined
      ? {
          status: 400,
          code: "PGRST204",
          message: "Could not find the 'lat' column of 'auditions' in the schema cache",
        }
      : null;
  const r = await auditions.createAudition(publicClient, log, "u1", input("Villeurbanne"));
  assert.equal(r.kind, "ok");
  assert.equal(db.tables.auditions[0].place_stale, true);
});

test("any other refusal is the write's own: not blamed on the place, not tried again", async () => {
  const errors: unknown[] = [];
  const watching = { ...log, error: (obj: unknown) => errors.push(obj) } as never;
  db.refuse = (method, url) =>
    method === "POST" && url.pathname.endsWith("/auditions")
      ? {
          status: 409,
          code: "23503",
          message:
            'insert or update on table "auditions" violates foreign key constraint "auditions_created_by_fkey"',
        }
      : null;
  const r = await auditions.createAudition(publicClient, watching, "nobody", input("Villeurbanne"));
  assert.equal(r.kind, "dbError");
  const inserts = db.requests.filter(
    (q) => q.method === "POST" && q.url.pathname.endsWith("/auditions"),
  );
  assert.equal(inserts.length, 1);
  assert.deepEqual(errors, []);
});

test("an online audition's edit never moves it", async () => {
  const [bucket] = db.insert("auditions", [
    {
      title: "Audition en ligne de mai",
      date: "2026-05-01",
      location: "Mairie de Bron (69)",
      content: "",
      status: "published",
      audition_en_ligne: true,
      citycode: "69029",
      place: { insee: "69029", lat: 45.7389, lng: 4.9132 },
    },
  ]);
  const place = { kind: "ban", citycode: "69266", lat: 45.77, lng: 4.88, type: "street" } as const;
  await auditions.updateAudition(publicClient, log, "u1", String(bucket.id), {
    location: "Ailleurs",
    place,
  });
  assert.equal(bucket.location, "Mairie de Bron (69)");
  assert.equal(bucket.place_path ?? null, null, "left to the job, from its town hall");
  assert.deepEqual(ban.calls, []);
});
