import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LocationGroup } from "@ac/shared";
import {
  FakeBan,
  FakeDb,
  FakeGeoApi,
  fakeEnv,
  installFakes,
  type BanHit,
  type FakeCommune,
  type Row,
} from "../../testing/fakes";

// /api/map and the admin list built two ways over the same auditions: by the
// geocoder at read time, as before map phase 1, and from the places the
// placement job stored — through the real geocoder (geo/geocode.ts, a fake
// BAN behind it), the real commune API client (a fake geo.api) and the real
// job (a fake PostgREST). The two must agree, but for the additive fields
// (unitPath, lieuId). Then groupsFromRows' own rules, on hand-made rows.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-groups-"));
fakeEnv(cacheDir, { TEST_TOOLS: "true" });
const db = new FakeDb();
const ban = new FakeBan();
const geo = new FakeGeoApi();
const restore = installFakes({ db, ban, geo });
after(async () => {
  restore();
  // The geocode cache's debounced write may still land in it.
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const RHONE = "69, Rhône, Auvergne-Rhône-Alpes";
const ISERE = "38, Isère, Auvergne-Rhône-Alpes";
const HA = "05, Hautes-Alpes, Provence-Alpes-Côte d'Azur";
const PARIS = "75, Paris, Île-de-France";
const muni = (
  name: string,
  citycode: string,
  context: string,
  population: number,
  coords: [number, number],
): BanHit => ({ name, citycode, context, population, coords, type: "municipality" });
const street = (
  name: string,
  city: string,
  citycode: string,
  context: string,
  coords: [number, number],
): BanHit => ({ name, city, citycode, context, coords, type: "street", score: 0.9 });

ban.municipality = {
  "La Tour-Du-Pin": [muni("La Tour-du-Pin", "38509", ISERE, 8111, [45.566, 5.444])],
  Lyon: [muni("Lyon", "69123", RHONE, 519127, [45.758, 4.835])],
  Villeurbanne: [muni("Villeurbanne", "69266", RHONE, 150000, [45.7707, 4.8846])],
  Bron: [muni("Bron", "69029", RHONE, 41000, [45.7386, 4.9134])],
  "Lyon 7e Arrondissement": [
    muni("Lyon 7e Arrondissement", "69387", RHONE, 85000, [45.7321, 4.8393]),
  ],
  "Fort-De-France": [muni("Fort-de-France", "97209", "972, Martinique", 76000, [14.6, -61.07])],
  Serres: [
    muni("Serres", "05166", HA, 1298, [44.4224, 5.7142]),
    muni("Serres", "54502", "54, Meurthe-et-Moselle, Grand Est", 254, [48.7, 6.4]),
  ],
  "Saint-Denis": [
    muni("Saint-Denis", "97411", "974, La Réunion", 155634, [-20.9, 55.4]),
    muni("Saint-Denis", "93066", "93, Seine-Saint-Denis, Île-de-France", 149077, [48.9, 2.35]),
  ],
  "Saint-Genis": [
    muni("Saint-Genis", "69900", RHONE, 1000, [45.7, 4.8]),
    muni("Saint-Genis", "01900", "01, Ain, Auvergne-Rhône-Alpes", 1200, [46.2, 5.2]),
  ],
  Embrun: [muni("Embrun", "05046", HA, 6000, [44.5638, 6.4958])],
  Paris: [muni("Paris", "75056", PARIS, 2100000, [48.859, 2.347])],
};
ban.address = {
  "Place Bellecour, Lyon": [street("Place Bellecour", "Lyon", "69382", RHONE, [45.7578, 4.832])],
  "Place De La République, Paris": [
    street("Place de la République", "Paris", "75111", PARIS, [48.8674, 2.3631]),
  ],
};
ban.reverse = {
  "45.7676,4.8799": { citycode: "69266", context: RHONE, city: "Villeurbanne" },
  "45.7387,4.9127": { citycode: "69029", context: RHONE, city: "Bron" },
};

const reg = (code: string, nom: string) => ({ code, nom });
const ARA = reg("84", "Auvergne-Rhône-Alpes");
const RHONE_DEP = reg("69", "Rhône");
const c = (
  code: string,
  nom: string,
  departement: FakeCommune["departement"],
  region: FakeCommune["region"],
  centre: [number, number],
  extra: Partial<FakeCommune> = {},
): FakeCommune => ({ code, nom, departement, region, centre, ...extra });
const arr = (code: string, nom: string, parent: string, dep: FakeCommune["departement"]) =>
  c(code, nom, dep, code.startsWith("75") ? reg("11", "Île-de-France") : ARA, [45.75, 4.84], {
    type: "arrondissement-municipal",
    codeParent: parent,
  });
geo.communes = {
  "38509": c("38509", "La Tour-du-Pin", reg("38", "Isère"), ARA, [45.566, 5.444]),
  "69382": arr("69382", "Lyon 2e Arrondissement", "69123", RHONE_DEP),
  "69387": arr("69387", "Lyon 7e Arrondissement", "69123", RHONE_DEP),
  "75111": arr("75111", "Paris 11e Arrondissement", "75056", reg("75", "Paris")),
  "75103": arr("75103", "Paris 3e Arrondissement", "75056", reg("75", "Paris")),
  "75056": c("75056", "Paris", reg("75", "Paris"), reg("11", "Île-de-France"), [48.8589, 2.347]),
  "69266": c("69266", "Villeurbanne", RHONE_DEP, ARA, [45.7707, 4.8846]),
  "69029": c("69029", "Bron", RHONE_DEP, ARA, [45.7386, 4.9134]),
  "97209": c(
    "97209",
    "Fort-de-France",
    reg("972", "Martinique"),
    reg("02", "Martinique"),
    [14.6, -61.07],
  ),
  "05166": c(
    "05166",
    "Serres",
    reg("05", "Hautes-Alpes"),
    reg("93", "Provence-Alpes-Côte d'Azur"),
    [44.4224, 5.7142],
  ),
  "05046": c(
    "05046",
    "Embrun",
    reg("05", "Hautes-Alpes"),
    reg("93", "Provence-Alpes-Côte d'Azur"),
    [44.5638, 6.4958],
  ),
  "69900": c("69900", "Saint-Genis", RHONE_DEP, ARA, [45.7, 4.8]),
};
geo.departements = {
  "05": { code: "05", nom: "Hautes-Alpes", region: reg("93", "Provence-Alpes-Côte d'Azur") },
};
geo.regions = [reg("53", "Bretagne"), ARA];

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
/** An audition as the old app writes it: location only. */
function audition(location: string, date: string, extra: Row = {}): Row {
  return {
    id: uuid(),
    title: `Audition ${n}`,
    date,
    location,
    content: "",
    status: "published",
    audition_en_ligne: false,
    citycode: null,
    place: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    ...extra,
  };
}
const online = (location: string, insee: string, date: string, place: Row) =>
  audition(location, date, {
    audition_en_ligne: true,
    citycode: insee,
    place: { insee, ...place },
  });

const fixtures = [
  // First, so that it is placed before the lieux that settle it: the job
  // leaves it unplaced, and settles it on its pass over the candidates.
  audition("Saint-Genis", "2026-03-01"),
  audition("Place Bellecour, Lyon", "2026-06-01"),
  audition("place bellecour, lyon", "2026-04-01"),
  audition("La Tour-du-Pin", "2026-05-20"),
  audition("marché des gratte-ciel", "2026-05-18"),
  audition("Marché des Gratte-Ciel, Villeurbanne", "2026-05-18"),
  audition("Parvis de la médiathèque, Bron", "2026-05-10"),
  audition("Lyon 7", "2026-05-05"),
  audition("Hautes-Alpes", "2026-05-01"),
  audition("Bretagne", "2026-04-28"),
  audition("Fort-de-France", "2026-04-20"),
  audition("Serres", "2026-04-18"),
  audition("Saint-Denis", "2026-04-15"),
  audition("Ribiers", "2026-04-10"),
  audition("France", "2020-12-05"),
  audition("Place de la République, Paris", "2026-04-05"),
  audition("Embrun", "2026-04-02", { status: "draft" }),
  online("Mairie de Villeurbanne (69)", "69266", "2026-05-01", {
    commune: "Villeurbanne",
    arrondissement: null,
    departementCode: "69",
    departementName: "Rhône",
    region: "Auvergne-Rhône-Alpes",
    lat: 45.7667,
    lng: 4.8796,
  }),
  online("Mairie de Paris Centre", "75103", "2026-04-01", {
    commune: "Paris",
    arrondissement: "Paris 3e",
    departementCode: "75",
    departementName: "Paris",
    region: "Île-de-France",
    lat: 48.8637,
    lng: 2.3615,
  }),
];
db.insert("auditions", fixtures);
db.tables.audition_testimony_counts = fixtures.map((a, i) => ({
  audition_id: a.id,
  total_count: 1 + (i % 4),
  verified_count: 1 + (i % 4),
}));

const { buildLocationGroups, warmLocationGeocodes } = await import("../map/locationGroups");
const { fetchAdminAuditions } = await import("../auditions/service");
const { runPlacementPass } = await import("./placementJob");
const { publicClient } = await import("../../lib/supabase");
const { invalidatePublicCaches } = await import("../../lib/publicCache");
const { resolve } = await import("../geo/geocode");
const { groupsFromRows, areaOfRow } = await import("./groups");

/** A group without the fields only the stored build has. */
const legacy = (g: LocationGroup) => {
  const copy: LocationGroup = { ...g };
  delete copy.unitPath;
  delete copy.lieuId;
  return copy;
};

async function adminAreas(source: "db" | "geocoder") {
  const r = await fetchAdminAuditions(publicClient, source);
  assert.equal(r.kind, "ok");
  return r.kind === "ok" ? r.auditions : [];
}

test("parity: /api/map and the admin list, geocoder vs stored places", async () => {
  // The geocoder build, warmed as before (the draft's lieu too, as the admin
  // list's background lookup would have).
  await warmLocationGeocodes();
  await resolve("Embrun");
  invalidatePublicCaches();
  const geocoder = await buildLocationGroups("geocoder");
  const geocoderAdmin = await adminAreas("geocoder");
  assert.ok(geocoder.length >= 12, `${geocoder.length} groups`);

  // Every row placed by the job: the rules pass, the stale rows, then the
  // homonyms the others settle.
  const banCalls = ban.calls.length;
  const first = await runPlacementPass({ rules: true });
  assert.equal(first.upstreamDown, false);
  assert.equal(ban.calls.length, banCalls, "the job reads the geocode cache, no new BAN call");
  const second = await runPlacementPass({ candidates: true });
  assert.equal(second.settled, 1, "Saint-Genis, once the Rhône's lieux are placed");
  assert.ok(db.tables.auditions.every((a) => a.place_stale === false));

  const stored = await buildLocationGroups("db");
  assert.deepEqual(stored.map(legacy), geocoder);
  // The additive fields, where a lieu is stored.
  for (const g of stored) {
    assert.ok(g.unitPath?.[0] === "FR", g.canonicalName);
    assert.match(g.lieuId ?? "", /^l:[0-9a-f]{16}$/);
  }
  const bellecour = stored.find((g) => g.canonicalName === "Place Bellecour, Lyon")!;
  assert.deepEqual(bellecour.unitPath, [
    "FR",
    "fr:reg:84",
    "fr:dep:69",
    "fr:com:69123",
    "fr:com:69382",
  ]);
  assert.equal(bellecour.auditions.length, 2);

  assert.deepEqual(await adminAreas("db"), geocoderAdmin);

  // A row the old app writes now (location only): filed as the geocoder
  // files it, with its lieu, until the job places it — in both builds.
  db.insert("auditions", [audition("Place Bellecour, Lyon", "2026-07-01")]);
  db.tables.audition_testimony_counts.push({
    audition_id: db.tables.auditions.at(-1)!.id,
    total_count: 1,
    verified_count: 0,
  });
  invalidatePublicCaches();
  const geocoderAfter = await buildLocationGroups("geocoder");
  const storedAfter = await buildLocationGroups("db");
  assert.deepEqual(storedAfter.map(legacy), geocoderAfter);
  assert.equal(storedAfter[0].canonicalName, "Place Bellecour, Lyon");
  assert.equal(storedAfter[0].auditions.length, 3);
  const adminAfter = await adminAreas("db");
  const pending = adminAfter.find((a) => a.date === "2026-07-01")!;
  assert.equal(pending.area.placement, "pending");
  assert.equal(pending.area.city, "Lyon", "with the geocoder's area meanwhile");
});

test("groupsFromRows: two picks of one name in two communes are two lieux (D12)", () => {
  const units = new Map(
    [
      ["FR", null, "France", null],
      ["fr:reg:84", "FR", "Auvergne-Rhône-Alpes", "84"],
      ["fr:dep:69", "fr:reg:84", "Rhône", "69"],
      ["fr:com:69266", "fr:dep:69", "Villeurbanne", "69266"],
      ["fr:com:69029", "fr:dep:69", "Bron", "69029"],
    ].map(([id, parent_id, name, code]) => [
      id!,
      { id: id!, parent_id, level: "x", name: name!, code },
    ]),
  );
  const placedAt = (unit: string, lieu: string, date: string, extra: Row = {}) => ({
    id: uuid(),
    title: "t",
    date,
    location: "Marché",
    testimony_count: 2,
    audition_en_ligne: false,
    place: null,
    place_path: ["FR", "fr:reg:84", "fr:dep:69", unit],
    locality_id: unit,
    lieu_key: "Marché",
    lat: 45.7,
    lng: 4.9,
    place_precision: "address",
    place_candidates: null,
    place_stale: false,
    lieu_id: lieu,
    ...extra,
  });
  const rows = [
    placedAt("fr:com:69266", "l:aaaaaaaaaaaaaaaa", "2026-05-03"),
    placedAt("fr:com:69029", "l:bbbbbbbbbbbbbbbb", "2026-05-02"),
    placedAt("fr:com:69266", "l:aaaaaaaaaaaaaaaa", "2026-05-01"),
    // Unplaced: on no point.
    placedAt("fr:com:69029", "l:x", "2026-04-01", {
      place_path: null,
      place_precision: "unplaced",
      lieu_id: null,
    }),
    // A unit missing from geo_units: filed as the geocoder files it (no
    // entry here: left out).
    placedAt("fr:com:99999", "l:cccccccccccccccc", "2026-03-01", { location: "Ailleurs" }),
  ];
  const groups = groupsFromRows(rows as never, units);
  assert.deepEqual(
    groups.map((g) => [g.canonicalName, g.city, g.auditions.length, g.totalTestimonies]),
    [
      ["Marché", "Villeurbanne", 2, 4],
      ["Marché", "Bron", 1, 2],
    ],
  );
  assert.deepEqual(areaOfRow(rows[3] as never, units), {
    canonicalName: "Marché",
    city: null,
    departementCode: null,
    departementName: null,
    region: null,
    placement: "unplaced",
  });
  assert.equal(areaOfRow(rows[4] as never, units).placement, "pending");
});

test("/api/map serves the stored build; ?source=geocoder (testing tools) the geocoder's", async () => {
  const { buildServer } = await import("../../server");
  const app = buildServer();
  await app.ready();
  try {
    const stored = (await app.inject({ url: "/api/map" })).json() as LocationGroup[];
    const geocoder = (
      await app.inject({ url: "/api/map?source=geocoder" })
    ).json() as LocationGroup[];
    assert.ok(stored.every((g) => "lieuId" in g));
    assert.ok(geocoder.every((g) => !("lieuId" in g)));
    assert.deepEqual(stored.map(legacy), geocoder);
  } finally {
    await app.close();
  }
});
