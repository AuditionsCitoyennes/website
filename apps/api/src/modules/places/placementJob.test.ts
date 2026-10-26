import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  FakeDb,
  FakeGeoApi,
  fakeEnv,
  installFakes,
  type FakeCommune,
  type Row,
} from "../../testing/fakes";
import type { BanFeature, BanSearch, Located } from "../geo/match";
import type { PlaceDeps } from "./placeLieu";

// The re-placement job against a fake PostgREST (the place columns, their
// generated columns, CHECKs and foreign key as the migration has them) and a
// fake commune API; the geocoder stubbed with match.ts over fixed BAN answers.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-placement-job-"));
fakeEnv(cacheDir);
const db = new FakeDb();
const geo = new FakeGeoApi();
const restore = installFakes({ db, geo });
after(async () => {
  restore();
  await rm(cacheDir, { recursive: true, force: true });
});

const { LOCATION_RULES } = await import("@ac/shared");
const { locate } = await import("../geo/match");
const { runPlacementPass } = await import("./placementJob");
const { rulesHash } = await import("./placeLieu");
const { forgetGeoUnits } = await import("./geoUnits");

const RHONE = { code: "69", nom: "Rhône" };
const ARA = { code: "84", nom: "Auvergne-Rhône-Alpes" };
const HA = { code: "05", nom: "Hautes-Alpes" };
const PACA = { code: "93", nom: "Provence-Alpes-Côte d'Azur" };
const fakeCommune = (
  code: string,
  nom: string,
  dep: FakeCommune["departement"],
  region: FakeCommune["region"],
  centre: [number, number],
  extra: Partial<FakeCommune> = {},
): FakeCommune => ({ code, nom, departement: dep, region, centre, ...extra });
geo.communes = {
  "05046": fakeCommune("05046", "Embrun", HA, PACA, [44.5638, 6.4958]),
  "05166": fakeCommune("05166", "Serres", HA, PACA, [44.4224, 5.7142]),
  "69029": fakeCommune("69029", "Bron", RHONE, ARA, [45.7386, 4.9134]),
  "69266": fakeCommune("69266", "Villeurbanne", RHONE, ARA, [45.7707, 4.8846], {
    mairie: [45.7667, 4.8796],
  }),
  "69900": fakeCommune("69900", "Saint-Genis", RHONE, ARA, [45.7, 4.8]),
  "69381": fakeCommune("69381", "Lyon 1er Arrondissement", RHONE, ARA, [45.767, 4.834], {
    type: "arrondissement-municipal",
    codeParent: "69123",
  }),
};

const muni = (
  name: string,
  citycode: string,
  context: string,
  population: number,
  coords: [number, number],
): BanFeature => ({
  coords,
  score: 0.95,
  type: "municipality",
  name,
  city: name,
  citycode,
  postcode: null,
  context,
  population,
});
const CTX_RHONE = "69, Rhône, Auvergne-Rhône-Alpes";
const CTX_HA = "05, Hautes-Alpes, Provence-Alpes-Côte d'Azur";
const MUNICIPALITIES: Record<string, BanFeature[]> = {
  Embrun: [muni("Embrun", "05046", CTX_HA, 6000, [44.5638, 6.4958])],
  Serres: [
    muni("Serres", "05166", CTX_HA, 1298, [44.4224, 5.7142]),
    muni("Serres", "54502", "54, Meurthe-et-Moselle, Grand Est", 254, [48.7, 6.4]),
  ],
  Bron: [muni("Bron", "69029", CTX_RHONE, 41000, [45.7386, 4.9134])],
  Villeurbanne: [muni("Villeurbanne", "69266", CTX_RHONE, 150000, [45.7707, 4.8846])],
  "Saint-Genis": [
    muni("Saint-Genis", "69900", CTX_RHONE, 1000, [45.7, 4.8]),
    muni("Saint-Genis", "01900", "01, Ain, Auvergne-Rhône-Alpes", 1200, [46.2, 5.2]),
  ],
};
const ban: BanSearch = async (q, opts) => (opts?.municipality ? (MUNICIPALITIES[q] ?? []) : []);

let located: string[] = [];
let geocoderDown = false;
const deps: Partial<PlaceDeps> = {
  locate: async (key): Promise<Located | "retry"> => {
    located.push(key);
    return geocoderDown ? "retry" : locate(key, ban);
  },
};

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
/** An audition as the old app writes it: location only, never placed. */
function legacy(location: string, extra: Row = {}): Row {
  const id = uuid();
  return {
    id,
    title: `Audition ${id.slice(-4)}`,
    date: "2026-05-01",
    location,
    content: "",
    status: "published",
    audition_en_ligne: false,
    citycode: null,
    place: null,
    created_at: new Date(Date.UTC(2026, 4, 1, 10) + n * 1000).toISOString(),
    ...extra,
  };
}
const rows = () => db.tables.auditions;
const row = (id: unknown) => rows().find((r) => r.id === id)!;

beforeEach(() => {
  db.tables = { auditions: [], geo_units: [] };
  db.requests = [];
  db.beforeAnswer = () => {};
  forgetGeoUnits();
  located = [];
  geocoderDown = false;
});

test("stale rows are placed, oldest first, 25 a page; a lieu's name is looked up once", async () => {
  db.insert("auditions", [
    ...Array.from({ length: 30 }, () => legacy("Embrun")),
    ...Array.from({ length: 30 }, () => legacy("serres")),
  ]);
  assert.ok(rows().every((r) => r.place_stale === true));

  const report = await runPlacementPass({ deps });

  assert.equal(report.placed, 60);
  assert.equal(report.upstreamDown, false);
  assert.ok(rows().every((r) => r.place_stale === false && r.place_path));
  assert.deepEqual(located, ["Embrun", "Serres"], "the others reuse the first's placement");
  const embrun = rows().filter((r) => r.location === "Embrun");
  assert.ok(embrun.every((r) => r.place_unit === "fr:com:05046" && r.lieu_key === "Embrun"));
  assert.equal(new Set(embrun.map((r) => r.lieu_id)).size, 1, "one lieu");
  // Serres settled by population, and its reusers carry its candidates.
  const serres = rows().filter((r) => r.location === "serres");
  assert.ok(serres.every((r) => r.place_unit === "fr:com:05166" && r.place_candidates));
  assert.ok(rows().every((r) => r.placed_rules === rulesHash()));
  // The units the rows reference, root first.
  assert.deepEqual(
    db.tables.geo_units.map((u) => u.id),
    ["FR", "fr:reg:93", "fr:dep:05", "fr:com:05046", "fr:com:05166"],
  );
  // Pages of 25 after the last row read, in created_at, id order.
  const reads = db.requests.filter(
    (r) => r.method === "GET" && r.url.searchParams.get("place_stale") === "eq.true",
  );
  assert.equal(reads.length, 3);
  assert.equal(reads[0].url.searchParams.get("order"), "created_at.asc.nullsfirst,id.asc");
  assert.equal(reads[0].url.searchParams.get("limit"), "25");
  assert.match(reads[1].url.searchParams.get("or") ?? "", /^\(created_at\.gt\."[^"]+",and\(/);
});

test("a row edited meanwhile is never overwritten: the next pass places its new location", async () => {
  const [a] = db.insert("auditions", [legacy("Embrun")]);
  db.beforeAnswer = (method, url) => {
    if (method === "PATCH" && url.searchParams.get("id") === `eq.${a.id}`) {
      // The old app moves it just before the job's write lands.
      Object.assign(row(a.id), { location: "Bron", place_stale: true });
      db.beforeAnswer = () => {};
    }
  };
  const first = await runPlacementPass({ deps });
  assert.equal(first.skipped, 1);
  assert.equal(first.placed, 0);
  assert.equal(row(a.id).place_path ?? null, null);
  assert.equal(row(a.id).location, "Bron");

  const second = await runPlacementPass({ deps });
  assert.equal(second.placed, 1);
  assert.equal(row(a.id).place_unit, "fr:com:69029");
  assert.equal(row(a.id).lieu_key, "Parvis Médiathèque, Bron");
  assert.equal(row(a.id).placed_location, "Bron");
});

test("the geocoder down: three lookups in a row fail, the pass stops and reports it", async () => {
  db.insert(
    "auditions",
    ["Embrun", "Bron", "Villeurbanne", "serres"].map((l) => legacy(l)),
  );
  geocoderDown = true;
  const report = await runPlacementPass({ deps });
  assert.equal(report.upstreamDown, true);
  assert.equal(report.retried, 3);
  assert.equal(report.placed, 0);
  assert.deepEqual(located, ["Embrun", "Parvis Médiathèque, Bron", "Villeurbanne"]);
  assert.ok(rows().every((r) => r.place_stale === true));
});

test("unplaced rows are written so, and not looked up again", async () => {
  db.insert("auditions", [legacy("France"), legacy("Ribiers"), legacy("Saint-Genis")]);
  const report = await runPlacementPass({ deps });
  assert.equal(report.unplaced, 3);
  assert.ok(rows().every((r) => r.place_stale === false && r.place_precision === "unplaced"));
  assert.ok(row(rows()[2].id).place_candidates, "Saint-Genis keeps its candidates");
  located = [];
  const again = await runPlacementPass({ deps });
  assert.equal(again.unplaced + again.placed, 0);
  assert.deepEqual(located, []);
});

test("an unplaced homonym is settled once support grows, with no geocoder call", async () => {
  const [genis] = db.insert("auditions", [legacy("Saint-Genis")]);
  await runPlacementPass({ deps });
  assert.equal(row(genis.id).place_precision, "unplaced");
  // Three lieux of the Rhône placed since.
  db.insert(
    "auditions",
    ["Bron", "Villeurbanne", "Lyon 1er"].map((l) => legacy(l)),
  );
  MUNICIPALITIES["Lyon 1er Arrondissement"] = [
    muni("Lyon 1er Arrondissement", "69381", CTX_RHONE, 30000, [45.767, 4.834]),
  ];
  await runPlacementPass({ deps });
  assert.deepEqual(db.placementSupport(), { "69": 3 });
  located = [];
  const report = await runPlacementPass({ deps, candidates: true });
  assert.equal(report.settled, 1);
  assert.deepEqual(located, []);
  assert.equal(row(genis.id).place_unit, "fr:com:69900");
  assert.ok(row(genis.id).place_candidates, "still marked a homonym: never support");
});

test("online rows: their town hall's units, their stored point, their own label", async () => {
  const [online] = db.insert("auditions", [
    legacy("Mairie de Villeurbanne (69)", {
      audition_en_ligne: true,
      citycode: "69266",
      place: {
        insee: "69266",
        commune: "Villeurbanne",
        arrondissement: null,
        departementCode: "69",
        departementName: "Rhône",
        region: "Auvergne-Rhône-Alpes",
        lat: 45.7667,
        lng: 4.8796,
      },
    }),
  ]);
  const report = await runPlacementPass({ deps });
  assert.equal(report.placed, 1);
  const r = row(online.id);
  assert.deepEqual(r.place_path, ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69266"]);
  assert.equal(r.lieu_key, "Mairie de Villeurbanne (69)");
  assert.deepEqual([r.lat, r.lng], [45.7667, 4.8796]);
  assert.equal(r.place_precision, "address");
  assert.deepEqual(located, [], "never the geocoder");
});

test("a place picked abroad keeps its unit; only its name follows the text", async () => {
  db.insert("geo_units", [
    { id: "DE", parent_id: null, level: "country", country: "DE", name: "Allemagne" },
  ]);
  const [abroad] = db.insert("auditions", [
    legacy("Berlin", {
      place_unit: "DE",
      place_path: ["DE"],
      lieu_key: "Berlin",
      lat: 52.52,
      lng: 13.4,
      place_precision: "locality",
      placed_location: "Berlin",
    }),
  ]);
  row(abroad.id).location = "berlin mitte";
  row(abroad.id).place_stale = true;
  await runPlacementPass({ deps });
  const r = row(abroad.id);
  assert.equal(r.place_unit, "DE");
  assert.equal(r.lieu_key, "Berlin Mitte");
  assert.equal(r.place_stale, false);
  assert.deepEqual(located, []);
});

test("rules pass: a change of LOCATION_RULES re-places exactly the lieux it changes", async () => {
  db.insert("auditions", [legacy("Embrun"), legacy("Bron"), legacy("Villeurbanne")]);
  await runPlacementPass({ deps });
  const before = rulesHash();
  assert.ok(rows().every((r) => r.placed_rules === before));

  // A deploy brings a rule: Embrun gets a curated point.
  LOCATION_RULES.unshift({ keywords: ["embrun"], canonical: "Embrun", coordinates: [44.56, 6.49] });
  try {
    const after = rulesHash();
    assert.notEqual(after, before);
    const dry = await runPlacementPass({ deps, rules: true, dryRun: true });
    assert.deepEqual([dry.rulesStaled, dry.rulesRestamped], [1, 2]);
    assert.ok(
      rows().every((r) => r.placed_rules === before),
      "a dry run writes nothing",
    );

    const report = await runPlacementPass({ deps, rules: true });
    assert.equal(report.rulesStaled, 1);
    assert.equal(report.rulesRestamped, 2);
    // Made stale, then placed again by the same pass, at the curated point.
    const embrun = rows().find((r) => r.location === "Embrun")!;
    assert.deepEqual([embrun.lat, embrun.lng], [44.56, 6.49]);
    assert.equal(embrun.place_precision, "address");
    assert.ok(rows().every((r) => r.placed_rules === after && r.place_stale === false));
    // Nothing left to do.
    const again = await runPlacementPass({ deps, rules: true });
    assert.deepEqual([again.rulesStaled, again.rulesRestamped, again.placed], [0, 0, 0]);
  } finally {
    LOCATION_RULES.shift();
  }

  // A rule that renames a lieu: its rows are made stale and re-keyed.
  LOCATION_RULES.unshift({
    keywords: ["villeurbanne"],
    canonical: "Centre, Villeurbanne",
    coordinates: [45.766, 4.88],
  });
  try {
    const report = await runPlacementPass({ deps, rules: true });
    assert.equal(report.rulesStaled, 1);
    const v = rows().find((r) => r.location === "Villeurbanne")!;
    assert.equal(v.lieu_key, "Centre, Villeurbanne");
  } finally {
    LOCATION_RULES.shift();
  }
});

test("a dry run reports what a pass would write, and writes nothing", async () => {
  db.insert("auditions", [legacy("Embrun"), legacy("France")]);
  const report = await runPlacementPass({ deps, dryRun: true, rules: true, candidates: true });
  assert.deepEqual([report.placed, report.unplaced], [1, 1]);
  assert.ok(rows().every((r) => r.place_stale === true));
  assert.equal(db.tables.geo_units.length, 0);
  assert.ok(!db.requests.some((r) => r.method !== "GET" && !r.url.pathname.includes("/rpc/")));
});

test("a write the table refuses is counted, and the row stays stale", async () => {
  const [a] = db.insert("auditions", [legacy("Embrun")]);
  db.beforeAnswer = (method) => {
    // The unit vanishes between its upsert and the row's write (a reset).
    if (method === "PATCH") db.tables.geo_units = [];
  };
  const report = await runPlacementPass({ deps });
  assert.equal(report.failed, 1);
  assert.equal(row(a.id).place_stale, true);
  db.beforeAnswer = () => {};
  // The units are written again on the next pass, all of them.
  const again = await runPlacementPass({ deps });
  assert.equal(again.placed, 1);
  assert.equal(db.tables.geo_units.length, 4);
});

test("a row whose placement throws is counted failed; the others are placed", async () => {
  db.insert("auditions", [legacy("Bron"), legacy("Embrun")]);
  const report = await runPlacementPass({
    deps: {
      ...deps,
      locate: async (key) => {
        if (key === "Parvis Médiathèque, Bron") throw new TypeError("a bug");
        return locate(key, ban);
      },
    },
  });
  assert.deepEqual([report.failed, report.placed], [1, 1]);
  assert.equal(rows().find((r) => r.location === "Embrun")!.place_stale, false);
  assert.equal(rows().find((r) => r.location === "Bron")!.place_stale, true);
});
