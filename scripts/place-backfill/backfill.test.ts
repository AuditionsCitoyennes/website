import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FrChain } from "../../apps/api/src/modules/places/fr";
import type { BanFeature, BanSearch } from "../../apps/api/src/modules/geo/match";
import type { PlanDeps, SourceRow } from "./plan";

// The backfill generator (scripts/place-backfill): the plan over stubbed
// upstreams, its SQL, its review table, the publishable-key reader over a
// fake PostgREST, and the guarantee that it never loads the API's
// configuration (config.ts reads apps/api/.env, which may hold a
// service-role key): were config.ts imported here, this unparsable URL would
// end the process.
process.env.SUPABASE_URL = "config.ts must not load";

const { frChainOfCommune } = await import("../../apps/api/src/modules/places/fr");
const { locate } = await import("../../apps/api/src/modules/geo/match");
const { rulesHash } = await import("../../apps/api/src/modules/places/placeLieu");
const { FakeBan, FakeDb, FakeGeoApi, BAN_URL, SUPABASE_URL, installFakes } =
  await import("../../apps/api/src/testing/fakes");
const { backfillOf, buildPlan, checkUpstreams, mostlyNowhere } = await import("./plan");
const { checkPoint } = await import("./etalab");
const { lastSegmentCommune, nearDuplicates, reviewMarkdown } = await import("./review");
const { countOrphanTestimonies, readAuditions, refuseKey } = await import("./source");
const { checkBackfill, expectedList, inlineIncludes, migrationSql, noticeErrors, testSql } =
  await import("./sql");
const { installGentleFetch, upstreamDeps } = await import("./upstream");

const scratch = mkdtempSync(join(tmpdir(), "ac-place-backfill-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// ---- Fixtures ------------------------------------------------------------------------

function commune(
  name: string,
  citycode: string,
  context: string,
  population: number,
  coords: [number, number],
): BanFeature {
  return {
    coords,
    score: 0.93,
    type: "municipality",
    name,
    city: name,
    citycode,
    postcode: null,
    context,
    population,
  };
}

const RHONE = "69, Rhône, Auvergne-Rhône-Alpes";
const HAUTES_ALPES = "05, Hautes-Alpes, Provence-Alpes-Côte d'Azur";
const SSD = "93, Seine-Saint-Denis, Île-de-France";
const MUNICIPALITIES: Record<string, BanFeature[]> = {
  Embrun: [commune("Embrun", "05046", HAUTES_ALPES, 6000, [44.5638, 6.4958])],
  Bron: [commune("Bron", "69029", RHONE, 41000, [45.7386, 4.9134])],
  Montreuil: [commune("Montreuil", "93048", SSD, 111000, [48.8638, 2.4485])],
  Bobigny: [commune("Bobigny", "93008", SSD, 53000, [48.9086, 2.4397])],
  Pantin: [commune("Pantin", "93055", SSD, 59000, [48.8944, 2.4094])],
  "Saint-Denis": [
    commune("Saint-Denis", "97411", "974, La Réunion", 155634, [-20.8823, 55.4504]),
    commune("Saint-Denis", "93066", SSD, 149077, [48.9362, 2.3574]),
  ],
  Ribiers: [],
  Lyon: [commune("Lyon", "69123", RHONE, 520000, [45.758, 4.835])],
  // A commune of Moselle that bears a country's name ("Berne, Suisse").
  Suisse: [commune("Suisse", "57662", "57, Moselle, Grand Est", 150, [48.9719, 6.7106])],
};
const search: BanSearch = async (q, opts) => (opts?.municipality ? (MUNICIPALITIES[q] ?? []) : []);

const AURA: [string, string] = ["84", "Auvergne-Rhône-Alpes"];
const PACA: [string, string] = ["93", "Provence-Alpes-Côte d'Azur"];
const IDF: [string, string] = ["11", "Île-de-France"];
function chain(
  code: string,
  nom: string,
  dep: [string, string],
  region: [string, string],
  centre: [number, number],
  mairie?: [number, number],
): FrChain {
  const point = (p: [number, number]) => ({
    type: "Point" as const,
    coordinates: [p[1], p[0]] as [number, number],
  });
  return frChainOfCommune({
    nom,
    code,
    departement: { code: dep[0], nom: dep[1] },
    region: { code: region[0], nom: region[1] },
    centre: point(centre),
    ...(mairie ? { mairie: point(mairie) } : {}),
  })!;
}
const CHAINS: Record<string, FrChain> = {
  "05046": chain("05046", "Embrun", ["05", "Hautes-Alpes"], PACA, [44.5638, 6.4958]),
  "69029": chain("69029", "Bron", ["69", "Rhône"], AURA, [45.7386, 4.9134], [45.739, 4.913]),
  "69266": chain(
    "69266",
    "Villeurbanne",
    ["69", "Rhône"],
    AURA,
    [45.7707, 4.8846],
    [45.7667, 4.8799],
  ),
  "93048": chain("93048", "Montreuil", ["93", "Seine-Saint-Denis"], IDF, [48.8638, 2.4485]),
  "93008": chain("93008", "Bobigny", ["93", "Seine-Saint-Denis"], IDF, [48.9086, 2.4397]),
  "93055": chain("93055", "Pantin", ["93", "Seine-Saint-Denis"], IDF, [48.8944, 2.4094]),
  "93066": chain("93066", "Saint-Denis", ["93", "Seine-Saint-Denis"], IDF, [48.9362, 2.3574]),
  "69123": chain("69123", "Lyon", ["69", "Rhône"], AURA, [45.758, 4.835], [45.7675, 4.8357]),
  "57662": chain("57662", "Suisse", ["57", "Moselle"], ["44", "Grand Est"], [48.9719, 6.7106]),
};

function deps(over: Partial<PlanDeps> = {}): PlanDeps {
  return {
    locate: (key) => locate(key, search),
    commune: async (code) => CHAINS[code] ?? null,
    departement: async (code) =>
      code === "05"
        ? {
            ...CHAINS["05046"],
            units: CHAINS["05046"].units.slice(0, 3),
            path: CHAINS["05046"].path.slice(0, 3),
            unit: "fr:dep:05",
            localityId: null,
            centre: null,
          }
        : null,
    region: async () => null,
    ...over,
  };
}

let n = 0;
function row(location: string, over: Partial<SourceRow> = {}): SourceRow {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `Audition ${n}`,
    date: "2026-05-01",
    location,
    status: "published",
    audition_en_ligne: false,
    citycode: null,
    place: null,
    created_at: "2026-05-02T10:00:00Z",
    ...over,
  };
}

const online = (citycode: string, date: string, lat: number, lng: number, label: string) =>
  row(label, { audition_en_ligne: true, citycode, date, place: { lat, lng, insee: citycode } });

/** Rows like production's: a lieu typed two ways, a keyword rule, homonyms, areas, town halls. */
function corpus(pantinStatus = "published"): SourceRow[] {
  return [
    row("Embrun"),
    row("embrun ", { status: "draft" }),
    row("Parvis de la médiathèque, Bron"),
    row("Médiathèque de Bron", { created_at: null }),
    row("Place Ferber, Bron"),
    row("Montreuil"),
    row("Bobigny"),
    row("Pantin", { status: pantinStatus }),
    row("Saint-Denis"),
    row("Hautes-Alpes"),
    row("France", { status: null }),
    row("Ribiers"),
    online("69266", "2026-09-01", 45.7667, 4.8799, "Mairie de Villeurbanne"),
    online("69266", "2026-08-01", 45.766, 4.879, "Mairie de Villeurbanne"),
    row("Mairie de Villeurbanne", {
      audition_en_ligne: true,
      citycode: "69266",
      date: "2026-07-01",
      place: { insee: "69266" },
    }),
    online("69029", "2026-09-01", 45.739, 4.913, "Mairie de Bron"),
  ];
}

const lieu = (plan: Awaited<ReturnType<typeof buildPlan>>, key: string) => {
  const l = plan.lieux.find((x) => x.key === key);
  assert.ok(l, `no lieu ${key}`);
  return l;
};

const META = {
  version: "20261026203000",
  generated: "2026-10-26T20:30:00Z",
  source: "example.test",
};

// ---- The plan ------------------------------------------------------------------------

test("each lieu is placed once for all its spellings, as the API places it", async () => {
  const plan = await buildPlan(corpus(), deps());
  assert.equal(plan.rules, rulesHash());

  const embrun = lieu(plan, "Embrun");
  assert.deepEqual(embrun.locations, ["Embrun", "embrun "]);
  assert.equal(embrun.klass, "commune");
  assert.deepEqual(embrun.placement.columns.place_path, [
    "FR",
    "fr:reg:93",
    "fr:dep:05",
    "fr:com:05046",
  ]);

  // Every spelling naming Bron reaches the médiathèque's rule ("bron" alone is
  // one of its keywords): its curated point, an address.
  const bron = lieu(plan, "Parvis Médiathèque, Bron");
  assert.deepEqual(bron.locations, [
    "Médiathèque de Bron",
    "Parvis de la médiathèque, Bron",
    "Place Ferber, Bron",
  ]);
  assert.equal(bron.klass, "address");
  assert.deepEqual([bron.placement.columns.lat, bron.placement.columns.lng], [45.7387, 4.9127]);

  assert.equal(lieu(plan, "Hautes-Alpes").klass, "departement");
  assert.equal(lieu(plan, "Hautes-Alpes").placement.columns.place_unit, "fr:dep:05");
  assert.equal(lieu(plan, "France").klass, "generic");
  assert.equal(lieu(plan, "Ribiers").klass, "unplaced");
  assert.equal(lieu(plan, "Ribiers").placement.columns.placed_rules, plan.rules);

  // Units: each once, ancestors first.
  const ids = plan.units.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const u of plan.units) {
    if (u.parent_id) assert.ok(ids.indexOf(u.parent_id) < ids.indexOf(u.id), u.id);
  }
});

test("same-named communes are settled against the plan's published lieux", async () => {
  const plan = await buildPlan(corpus(), deps());
  assert.equal(plan.support.get("93"), 3);
  const sd = lieu(plan, "Saint-Denis");
  assert.equal(sd.klass, "homonym");
  assert.equal(sd.settledOn, "fr:com:93066");
  assert.equal(sd.placement.columns.place_unit, "fr:com:93066");
  assert.equal((sd.placement.columns.place_candidates as unknown[]).length, 2);

  // A draft is no support: two published lieux in 93 do not settle it.
  const fewer = await buildPlan(corpus("draft"), deps());
  assert.equal(fewer.support.get("93"), 2);
  const unsettled = lieu(fewer, "Saint-Denis");
  assert.equal(unsettled.klass, "homonym");
  assert.equal(unsettled.settledOn, null);
  assert.equal(unsettled.placement.columns.place_path, null);
  assert.equal(unsettled.placement.columns.place_precision, "unplaced");
});

test("a town hall is listed with its units, each month keeping its own point", async () => {
  const plan = await buildPlan(corpus(), deps());
  const v = lieu(plan, "69266");
  assert.equal(v.klass, "online");
  assert.equal(v.hall?.columns.place_unit, "fr:com:69266");
  assert.equal(v.hall?.columns.place_precision, "address");
  assert.equal(v.hall?.columns.placed_rules, null);
  // Shown in the review: the newest month with a point.
  assert.deepEqual([v.placement.columns.lat, v.placement.columns.lng], [45.7667, 4.8799]);
  assert.equal(v.otherPoints?.length, 1);
  assert.equal(v.pointless?.length, 1);
  assert.equal(lieu(plan, "69029").otherPoints, undefined);

  // The value carries no point: the UPDATE reads each row's own.
  const hall = backfillOf(plan, META).values.find((x) => x.online && x.citycode === "69266")!;
  assert.deepEqual([hall.lat, hall.lng, hall.unit], [null, null, "fr:com:69266"]);

  // A town hall whose months read have no point is still listed under its
  // units, for its months the key cannot read.
  const noPoint = await buildPlan(
    [row("Mairie de Bron", { audition_en_ligne: true, citycode: "69029", place: {} })],
    deps(),
  );
  const bron = lieu(noPoint, "69029");
  assert.equal(bron.placement.columns.place_path, null);
  assert.equal(bron.hall?.columns.place_unit, "fr:com:69029");
  assert.ok(noPoint.units.some((u) => u.id === "fr:com:69029"));
});

test("the upstreams are checked on Lyon before anything is placed", async () => {
  await checkUpstreams(deps());
  await assert.rejects(
    checkUpstreams(deps({ locate: async () => null })),
    /does not place Lyon in 69123/,
  );
  await assert.rejects(
    checkUpstreams(deps({ commune: async () => null })),
    /geo\.api\.gouv\.fr does not know Lyon/,
  );
  await assert.rejects(
    checkUpstreams(deps({ locate: async () => "retry" }), { retryWaits: [1] }),
    /did not answer \(2 tries\)/,
  );
});

test("an upstream that keeps not answering stops the plan; one that comes back does not", async () => {
  let calls = 0;
  const flaky = deps({
    locate: async (key) => (key === "Embrun" && calls++ < 1 ? "retry" : locate(key, search)),
  });
  const plan = await buildPlan([row("Embrun")], flaky, { retryWaits: [1] });
  assert.equal(lieu(plan, "Embrun").klass, "commune");
  await assert.rejects(
    buildPlan([row("Embrun")], deps({ locate: async () => "retry" }), { retryWaits: [1, 1] }),
    /Embrun: the geocoder or the commune API did not answer \(3 tries\)/,
  );
});

test("a plan with most offline lieux on no point is held back", async () => {
  assert.equal(mostlyNowhere(await buildPlan(corpus(), deps())), null);
  const blind = await buildPlan(corpus(), deps({ locate: async () => null }));
  assert.match(mostlyNowhere(blind)!, /^8 of 8 offline lieux land on no point/);
});

// ---- The SQL -----------------------------------------------------------------------

test("the backfill lists one value per spelling and per town hall", async () => {
  const plan = await buildPlan(corpus(), deps());
  const b = backfillOf(plan, META);
  checkBackfill(b);
  const embrun = b.values.filter((v) => v.key === "Embrun");
  assert.deepEqual(
    embrun.map((v) => v.location),
    ["Embrun", "embrun "],
  );
  const hall = b.values.find((v) => v.online && v.citycode === "69266")!;
  assert.equal(hall.key, null);
  assert.equal(hall.location, "Mairie de Villeurbanne");
  const list = expectedList(b);
  assert.deepEqual(list.offline["embrun "], ["FR", "fr:reg:93", "fr:dep:05", "fr:com:05046"]);
  assert.deepEqual(list.offline.France, []);
  assert.deepEqual(list.online["69266"], ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69266"]);
  assert.equal(list.migration, "20261026203000_backfill_places_fr.sql");
  assert.equal(list.rules, rulesHash());
});

test("the migration keys offline rows by text, town halls by code, never-placed rows only", async () => {
  const b = backfillOf(await buildPlan(corpus(), deps()), META);
  const sql = migrationSql(b, "docs/backfill-places-2026-10-26.md");
  assert.match(sql, /^set lock_timeout = '200ms';$/m);
  assert.match(sql, /on conflict \(id\) do nothing;/);
  assert.match(sql, /^do \$backfill\$$/m);
  assert.match(sql, /^\$backfill\$;$/m);
  // Offline: by raw location, offline rows only, the rules hash stamped.
  assert.match(
    sql,
    /where a\.placed_location is null\n\s+and not a\.audition_en_ligne\n\s+and a\.location = v\.location/,
  );
  assert.match(sql, new RegExp(`placed_rules = '${rulesHash()}', geo_release = v\\.release`));
  // Online: by code, online rows only, each at its own point, or on no point.
  assert.equal(
    sql.match(
      /where a\.placed_location is null\n\s+and a\.audition_en_ligne\n\s+and a\.citycode = t\.citycode/g,
    )?.length,
    2,
  );
  assert.match(sql, /lat = \(a\.place->>'lat'\)::double precision/);
  assert.match(sql, /\(a\.place->'lat'\)::numeric between -90 and 90/);
  assert.match(sql, /and \(not t\.known or not \(/);
  assert.equal(sql.match(/lieu_key = a\.location/g)?.length, 2);
  assert.doesNotMatch(
    sql,
    /lat = v\.lat, lng = v\.lng, place_precision = v\.prec, place_candidates = v\.cand,\n\s+placed_location = a\.location, placed_rules = null/,
  );
  // The first row types every column; a quote in a name is doubled.
  assert.ok(
    sql.includes(
      "('Bobigny'::text, 'fr:com:93008'::text, " +
        "array['FR', 'fr:reg:11', 'fr:dep:93', 'fr:com:93008']::text[], 'fr:com:93008'::text, " +
        "'Bobigny'::text, 48.9086::double precision, 2.4397::double precision, 'commune'::text, " +
        "null::jsonb, 'geoapi-2026'::text),",
    ),
  );
  assert.ok(sql.includes("('69029'::text, 'fr:com:69029'::text, "));
  assert.match(sql, /'Provence-Alpes-Côte d''Azur'/);
  // NOTICEs of what this run placed, and of what it left. The listed online
  // rows already placed are counted over every town hall (69029 and 69266:
  // known or not), before either online UPDATE places one.
  assert.match(sql, /get diagnostics n_own = row_count;/);
  assert.match(sql, /into n_map, n_nowhere, n_kept_offline/);
  assert.match(
    sql,
    /\(select count\(\*\) from public\.auditions a join t on a\.citycode = t\.citycode\n\s+where a\.audition_en_ligne and a\.placed_location is not null\)\n\s+into n_pointless, n_kept_online/,
  );
  assert.ok(
    sql.indexOf("into n_pointless, n_kept_online") < sql.indexOf("set place_unit = t.unit"),
  );
  assert.ok(sql.includes("('69029'::text, true),"));
  assert.match(sql, /raise notice 'backfill_places_fr: placed now: /);
  assert.match(sql, /already placed \(by the placement job, or a run before this one\)/);
  // Units before the rows that reference them, parents before children.
  assert.ok(sql.indexOf("('FR', null, 'country'") < sql.indexOf("('fr:reg:84', 'FR'"));

  // Without town halls, no online statement; without offline lieux, no offline one.
  const offlineOnly = migrationSql({ ...b, values: b.values.filter((v) => !v.online) }, "r.md");
  assert.doesNotMatch(offlineOnly, /a\.citycode = t\.citycode/);
  const onlineOnly = migrationSql({ ...b, values: b.values.filter((v) => v.online) }, "r.md");
  assert.doesNotMatch(onlineOnly, /a\.location = v\.location/);
  assert.match(onlineOnly, /n_map bigint := 0;/);
  // Only town halls geo.api does not know: no own-point UPDATE, and their rows
  // already placed are counted all the same.
  const unknownOnly = migrationSql(
    {
      ...b,
      units: [],
      values: [
        {
          online: true,
          location: "Mairie inconnue",
          citycode: "00000",
          key: null,
          unit: null,
          path: null,
          locality: null,
          lat: null,
          lng: null,
          precision: "unplaced",
          candidates: null,
          release: null,
        },
      ],
    },
    "r.md",
  );
  assert.doesNotMatch(unknownOnly, /set place_unit = t\.unit/);
  assert.match(unknownOnly, /\('00000'::text, false\)/);
  assert.match(unknownOnly, /into n_pointless, n_kept_online/);
});

test("the fixture test runs the migration twice, by \\ir, and inlines", async () => {
  const b = backfillOf(await buildPlan(corpus(), deps()), META);
  const fixture = testSql(b, "../migrations/20261026203000_backfill_places_fr.sql");
  const includes = fixture.match(
    /^\\ir \.\.\/migrations\/20261026203000_backfill_places_fr\.sql$/gm,
  );
  assert.equal(includes?.length, 2);
  assert.match(fixture, /^begin;$/m);
  assert.match(fixture, /^rollback;$/m);
  assert.match(
    fixture,
    /\('changed', null, 'Bobigny \(modifié après la revue\)', false, null, null\)/,
  );
  assert.match(fixture, /\('placed', null, 'Bobigny', false, null, null\)/);
  // An online row of an unlisted town hall labelled like a listed spelling;
  // an offline row carrying a listed code.
  assert.match(fixture, /\('untouched', null, 'Bobigny', true, '99999', /);
  assert.match(fixture, /\('untouched', null, 'Lieu non revu \(fixture\)', false, '69029', '/);
  assert.match(
    fixture,
    /\('untouched', null, 'Autre lieu non revu \(fixture\)', false, '69029', null\)/,
  );
  assert.match(
    fixture,
    /\('renamed', \d+, 'Libellé changé \(fixture\)', true, '69029', '\{"lat": 11\.5, "lng": 21\.5\}'::jsonb\)/,
  );
  assert.match(
    fixture,
    /\('pointless', \d+, 'Sans point \(fixture\)', true, '69029', '\{\}'::jsonb\)/,
  );
  assert.match(fixture, /\('far', \d+, 'Point hors limites \(fixture\)', true, '69029', /);
  // Online rows already placed, with a point and without: kept as they are.
  assert.match(
    fixture,
    /\('placed', null, 'Déjà placée \(fixture\)', true, '69029', '\{"lat": 45\.3, "lng": 5\.3\}'::jsonb\)/,
  );
  assert.match(
    fixture,
    /\('placed', null, 'Déjà placée, sans point \(fixture\)', true, '69029', '\{\}'::jsonb\)/,
  );
  assert.match(fixture, /except select \* from backfill_placed_before p where p\.id = f\.id/);
  // What each run placed and left, printed for db:check to hold the NOTICEs to.
  assert.equal(fixture.match(/^insert into backfill_seen /gm)?.length, 2);
  assert.equal(
    fixture.match(/^select pg_catalog\.jsonb_build_object\(\n\s+'run', [12],/gm)?.length,
    2,
  );
  // A town hall geo.api does not know gets its own already-placed row.
  const unknown = {
    ...b.values.find((v) => v.online)!,
    citycode: "00000",
    unit: null,
    path: null,
    locality: null,
    precision: "unplaced",
    release: null,
  };
  assert.match(
    testSql({ ...b, values: [...b.values, unknown] }, "m.sql"),
    /\('placed', null, 'Déjà placée, mairie inconnue \(fixture\)', true, '00000', /,
  );
  const inlined = inlineIncludes(fixture, () => "-- the migration");
  assert.equal(inlined.match(/^-- the migration$/gm)?.length, 2);
  assert.doesNotMatch(inlined, /^\\ir /m);
});

test("a backfill the UPDATE would apply ambiguously is refused", async () => {
  const b = backfillOf(await buildPlan(corpus(), deps()), META);
  assert.throws(() => checkBackfill({ ...b, values: [...b.values, b.values[0]] }), /listed twice/);
  const offPath = { ...b.values[0], unit: "fr:com:69029" };
  assert.throws(() => checkBackfill({ ...b, values: [offPath] }), /ends its path/);
  const without = (id: string) => ({ ...b, units: b.units.filter((u) => u.id !== id) });
  assert.throws(() => checkBackfill(without("fr:com:05046")), /unit fr:com:05046 is not inserted/);
  assert.throws(() => checkBackfill(without("fr:dep:05")), /its parent fr:dep:05 is not inserted/);
  const offLocality = { ...b.values[0], locality: "fr:com:69029" };
  assert.throws(
    () => checkBackfill({ ...b, values: [offLocality] }),
    /locality fr:com:69029 is off/,
  );
  assert.throws(() => checkBackfill({ ...b, values: [] }), /nothing to backfill/);
  const hall = b.values.find((v) => v.online)!;
  assert.throws(
    () => checkBackfill({ ...b, values: [{ ...hall, lat: 45.7, lng: 4.9 }] }),
    /a town hall has none/,
  );
  assert.throws(
    () => checkBackfill({ ...b, values: [{ ...b.values[0], location: "x $backfill$ y" }] }),
    /holds \$backfill\$/,
  );
});

test("the NOTICEs of each run are held to what the table says", () => {
  const notices = (runs: number[][]) =>
    runs
      .flatMap(([map, nowhere, own, pointless, ko, kn, so, sn]) => [
        `psql:<stdin>:40: NOTICE:  backfill_places_fr: placed now: ${map + nowhere} offline auditions (${map} on the map, ${nowhere} on no point), ${own + pointless} online (${own} at their own point, ${pointless} on no point)`,
        `psql:<stdin>:40: NOTICE:  backfill_places_fr: ${ko + kn} listed auditions were already placed (by the placement job, or a run before this one): left as they were (${ko} offline, ${kn} online)`,
        `psql:<stdin>:40: NOTICE:  backfill_places_fr: ${so + sn} auditions still stale (${so} offline, ${sn} online): changed since the review, or not listed — the placement job places them`,
      ])
      .join("\n");
  const table = (runs: number[][]) =>
    runs
      .map(([map, nowhere, own, pointless, ko, kn, so, sn], i) =>
        JSON.stringify({
          run: i + 1,
          map,
          nowhere,
          own,
          pointless,
          kept_offline: ko,
          kept_online: kn,
          stale_offline: so,
          stale_online: sn,
        }),
      )
      .join("\n");
  const runs = [
    [5, 2, 3, 2, 1, 3, 9, 4],
    [0, 0, 0, 0, 8, 8, 9, 4],
  ];
  assert.deepEqual(noticeErrors(table(runs), notices(runs)), []);
  // The second run counts the unknown town hall's rows the first placed; NOTICEs miss them.
  const missed = [runs[0], [0, 0, 0, 0, 8, 6, 9, 4]];
  assert.deepEqual(noticeErrors(table(runs), notices(missed)), [
    "run 2: the NOTICEs say kept_online 6; the table kept_online 8",
  ]);
  assert.match(noticeErrors(table(runs), notices(runs.slice(0, 1)))[0], /NOTICEs for 1/);
  assert.match(
    noticeErrors(table(runs), notices(runs).replace("left as they were", "kept"))[0],
    /run 1: NOTICEs not as the migration words them/,
  );
});

// ---- The review --------------------------------------------------------------------

test("the review lists every lieu and flags what to look at", async () => {
  const plan = await buildPlan(corpus(), deps());
  const b = backfillOf(plan, META);
  const near = nearDuplicates(plan);
  // The médiathèque's curated point is 41 m from Bron's town hall.
  const media = plan.lieux.findIndex((l) => l.key === "Parvis Médiathèque, Bron");
  const hall = plan.lieux.findIndex((l) => l.key === "69029");
  assert.deepEqual(
    near.map((p) => [p.a, p.b]),
    [[media, hall]],
  );
  const md = reviewMarkdown({
    plan,
    backfill: b,
    migrationPath: "supabase/migrations/20261026203000_backfill_places_fr.sql",
    reviewPath: "docs/backfill-places-2026-10-26.md",
    ban: "https://api-adresse.data.gouv.fr",
    rows: 15,
    nullCreatedAt: 1,
    nullStatus: 1,
    published: 13,
    drafts: 1,
    orphans: "not readable with this key (HTTP 401)",
    contours: new Map([[media, { kind: "outside", metres: 120 }]]),
  });
  assert.equal(md.match(/^\| \d+ \| /gm)?.length, plan.lieux.length);
  assert.match(md, /\| Without `created_at` \| 1 \|/);
  assert.match(
    md,
    /\| Testimonies without an audition \| not readable with this key \(HTTP 401\) \|/,
  );
  assert.match(
    md,
    /«&nbsp;Parvis de la médiathèque, Bron&nbsp;» → «&nbsp;Parvis Médiathèque, Bron&nbsp;»/,
  );
  assert.match(
    md,
    /#7 «&nbsp;Parvis Médiathèque, Bron&nbsp;» and #10 «&nbsp;Mairie de Bron&nbsp;»: 41 m apart\./,
  );
  assert.match(md, /«&nbsp;Place Ferber, Bron&nbsp;» → «&nbsp;Parvis Médiathèque, Bron&nbsp;»/);
  assert.match(md, /Saint-Denis \(974, 97411; pop\. 155634; 0 lieux in 974\)/);
  assert.match(md, /Settled on fr:com:93066/);
  assert.match(md, /lies 120 m outside fr:com:69029/);
  assert.match(md, /1 month\(s\) stored another point than the newest: each keeps its own/);
  assert.match(md, /1 month\(s\) with no point of their own: on no point/);
  assert.match(md, /a generic text \(GENERIC_LOCATION\)/);
});

test("a lieu filed under the commune its text's last segment names is flagged", async () => {
  // As if Suisse were missing from geo/countries.ts (or misspelt): "Berne,
  // Suisse" reaches the commune of Moselle, as it did before match.ts set the
  // countries it lists aside.
  const unguarded = deps({
    locate: (key) => locate(key === "Berne, Suisse" ? "Suisse" : key, search),
  });
  const plan = await buildPlan(
    [row("Berne, Suisse"), row("Place Dosse, Embrun"), row("Embrun"), row("Bobigny")],
    unguarded,
  );
  const names = new Map(plan.units.map((u) => [u.id, u.name]));
  assert.deepEqual(lastSegmentCommune(lieu(plan, "Berne, Suisse"), names), {
    text: "Berne, Suisse",
    unit: "fr:com:57662",
  });
  // The French commune meant, filed the same way: listed too, for a person to tell.
  assert.equal(lastSegmentCommune(lieu(plan, "Place Dosse, Embrun"), names)?.unit, "fr:com:05046");
  // A text with no comma names its commune outright.
  assert.equal(lastSegmentCommune(lieu(plan, "Embrun"), names), null);
  assert.equal(lastSegmentCommune(lieu(plan, "Bobigny"), names), null);
  // A trailing "France" is dropped, as match.ts drops it.
  const withFrance = {
    ...lieu(plan, "Place Dosse, Embrun"),
    key: "Place Dosse, Embrun, France",
    locations: ["Place Dosse, Embrun, France"],
  };
  assert.equal(lastSegmentCommune(withFrance, names)?.unit, "fr:com:05046");
  // A town hall is placed by its code, never by its text.
  assert.equal(
    lastSegmentCommune({ ...lieu(plan, "Place Dosse, Embrun"), online: true }, names),
    null,
  );

  const md = reviewMarkdown({
    plan,
    backfill: backfillOf(plan, META),
    migrationPath: "supabase/migrations/20261026203000_backfill_places_fr.sql",
    reviewPath: "docs/backfill-places-2026-10-26.md",
    ban: "https://api-adresse.data.gouv.fr",
    rows: 4,
    nullCreatedAt: 0,
    nullStatus: 0,
    published: 4,
    drafts: 0,
    orphans: 0,
    contours: "no contours",
  });
  assert.match(md, /^\| 1 \| Berne, Suisse \| .*\| commune by last segment \|$/m);
  assert.match(md, /^\| 4 \| Place Dosse, Embrun \| .*\| commune by last segment, near #3 \|$/m);
  assert.doesNotMatch(md, /^\| [23] \| .*commune by last segment/m);
  assert.match(md, /^### Communes named by the text's last segment$/m);
  assert.match(md, /^- #1 «&nbsp;Berne, Suisse&nbsp;» → Suisse \(57, fr:com:57662\), commune\.$/m);
  assert.match(
    md,
    /^- #4 «&nbsp;Place Dosse, Embrun&nbsp;» → Embrun \(05, fr:com:05046\), commune\.$/m,
  );

  // match.ts itself keeps "Berne, Suisse" off the map: nothing to flag there.
  const guarded = await buildPlan([row("Berne, Suisse")], deps());
  assert.equal(lieu(guarded, "Berne, Suisse").klass, "unplaced");
  assert.equal(lastSegmentCommune(lieu(guarded, "Berne, Suisse"), names), null);
  const none = reviewMarkdown({
    plan: guarded,
    backfill: backfillOf(guarded, META),
    migrationPath: "m.sql",
    reviewPath: "r.md",
    ban: "https://api-adresse.data.gouv.fr",
    rows: 1,
    nullCreatedAt: 0,
    nullStatus: 0,
    published: 1,
    drafts: 0,
    orphans: 0,
    contours: "no contours",
  });
  assert.match(none, /No lieu is filed under a commune named by its text's last segment\./);
});

test("a point is checked against its unit's polygon", () => {
  const square: [number, number][] = [
    [4.9, 45.73],
    [4.92, 45.73],
    [4.92, 45.75],
    [4.9, 45.75],
    [4.9, 45.73],
  ];
  const contours = new Map([["fr:com:69029", [[square]]]]);
  assert.deepEqual(checkPoint(contours, "fr:com:69029", [45.74, 4.91]), { kind: "inside" });
  const out = checkPoint(contours, "fr:com:69029", [45.74, 4.9213]);
  assert.equal(out.kind, "outside");
  assert.ok(out.kind === "outside" && out.metres > 90 && out.metres < 110, JSON.stringify(out));
  assert.deepEqual(checkPoint(contours, "fr:com:05046", [44.5, 6.4]), { kind: "unknown" });
});

// ---- Reading the target -----------------------------------------------------------------

const anonJwt = (role: string) =>
  ["e30", Buffer.from(JSON.stringify({ role })).toString("base64url"), "sig"].join(".");

test("only a publishable or anon key is taken", () => {
  assert.equal(refuseKey("sb_publishable_abc"), null);
  assert.equal(refuseKey(anonJwt("anon")), null);
  assert.match(refuseKey(anonJwt("service_role"))!, /service_role/);
  assert.match(refuseKey("sb_secret_abc")!, /secret/);
  assert.match(refuseKey("hunter2")!, /not a publishable/);
});

test("the auditions are read a page at a time, past 1,000, with the key as given", async () => {
  const db = new FakeDb();
  for (let i = 0; i < 2345; i++) db.insert("auditions", [{ ...row(`Lieu ${i}`), id: undefined }]);
  db.tables.testimonies = [
    { id: "t1", audition_id: null },
    { id: "t2", audition_id: "x" },
  ];
  const restore = installFakes({ db });
  try {
    const rows = await readAuditions({ url: SUPABASE_URL, key: "sb_publishable_abc" });
    assert.equal(rows.length, 2345);
    assert.equal(new Set(rows.map((r) => r.id)).size, 2345);
    const gets = db.requests.filter((r) => r.url.pathname === "/rest/v1/auditions");
    assert.equal(gets.length, 4); // three pages and the empty one
    assert.equal(gets[0].url.searchParams.get("limit"), "1000");
    assert.equal(await countOrphanTestimonies({ url: SUPABASE_URL, key: "sb_publishable_abc" }), 1);

    // A row written between two pages: the counts disagree, the run stops.
    let pages = 0;
    db.beforeAnswer = (method, url) => {
      if (url.pathname === "/rest/v1/auditions" && ++pages === 2) {
        db.insert("auditions", [{ ...row("Late"), id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }]);
      }
    };
    await assert.rejects(
      readAuditions({ url: SUPABASE_URL, key: "sb_publishable_abc" }),
      /written to meanwhile/,
    );
  } finally {
    restore();
  }
});

// ---- The upstreams ---------------------------------------------------------------------

test("BAN and geo.api are asked through the API's clients, once per answer", async () => {
  const ban = new FakeBan();
  ban.municipality.Embrun = [
    {
      coords: [44.5638, 6.4958],
      type: "municipality",
      name: "Embrun",
      citycode: "05046",
      context: HAUTES_ALPES,
      population: 6000,
    },
  ];
  const geo = new FakeGeoApi();
  geo.communes["05046"] = {
    nom: "Embrun",
    code: "05046",
    departement: { code: "05", nom: "Hautes-Alpes" },
    region: { code: "93", nom: "Provence-Alpes-Côte d'Azur" },
    centre: [44.5638, 6.4958],
  };
  const unfake = installFakes({ ban, geo });
  const cache = join(scratch, "http-cache.json");
  const restore = installGentleFetch([new URL(BAN_URL).host, "geo.api.gouv.fr"], cache);
  try {
    const d = upstreamDeps(BAN_URL);
    const plan = await buildPlan([row("Embrun"), row("Embrun")], d);
    assert.equal(lieu(plan, "Embrun").placement.columns.place_unit, "fr:com:05046");
    const asked = ban.calls.length;
    assert.ok(asked > 0);
    assert.notEqual(await d.locate("Embrun"), "retry");
    assert.equal(ban.calls.length, asked, "a kept answer is not asked again");

    ban.failWith = 503;
    assert.equal(await d.locate("Briançon"), "retry");
    ban.failWith = 429;
    assert.equal(await d.locate("Briançon"), "retry");
    ban.failWith = 400;
    assert.equal(await d.locate("Gap"), null);
    // A BAN that does not exist there: the run stops, and nothing is kept.
    ban.failWith = 404;
    await assert.rejects(
      d.locate("Veynes"),
      /BAN search 404 from http:\/\/ban\.test.*is --ban right/,
    );
    ban.failWith = 410;
    await assert.rejects(d.locate("Veynes"), /BAN search 410/);
    ban.failWith = null;
    assert.equal(await d.commune("99999"), null); // geo.api's 404: no such code, kept
  } finally {
    restore();
    unfake();
  }
  const kept = JSON.parse(readFileSync(cache, "utf8")) as Record<string, { status: number }>;
  assert.ok(Object.keys(kept).some((k) => k.startsWith(BAN_URL)));
  assert.ok(Object.values(kept).every((v) => v.status === 200 || v.status === 404));
  assert.ok(
    Object.entries(kept).every(([k, v]) => v.status === 200 || k.includes("geo.api.gouv.fr")),
    "a BAN 404 is never kept",
  );
  assert.ok(Object.keys(kept).some((k) => k.includes("/communes/99999")));

  // A cache file from an older run holding a BAN 404: not taken as an answer.
  const stale = `${BAN_URL}/search/?q=Veynes&limit=5&type=municipality`;
  writeFileSync(cache, JSON.stringify({ [stale]: { status: 404, type: "text/plain", body: "" } }));
  const again = new FakeBan();
  const unfakeAgain = installFakes({ ban: again, geo });
  const restoreAgain = installGentleFetch([new URL(BAN_URL).host, "geo.api.gouv.fr"], cache);
  try {
    assert.equal(await upstreamDeps(BAN_URL).locate("Veynes"), null);
    assert.ok(
      again.calls.some((c) => c.startsWith("/search/?q=Veynes")),
      "asked again",
    );
  } finally {
    restoreAgain();
    unfakeAgain();
  }
});

test("a curated lieu whose point BAN cannot reverse-geocode is retried, never filed by the forward match", async () => {
  // "Parvis Médiathèque, Bron" has curated coordinates (LOCATION_RULES): the
  // API files it under the commune BAN gives for them.
  class ReverseDown extends FakeBan {
    reverseStatus = 503;
    override answer(url: URL): Response {
      if (url.pathname === "/reverse/") {
        this.calls.push(`${url.pathname}?${url.searchParams}`);
        return new Response("down", { status: this.reverseStatus });
      }
      return super.answer(url);
    }
  }
  const ban = new ReverseDown();
  ban.municipality.Bron = [
    {
      coords: [45.7386, 4.9134],
      type: "municipality",
      name: "Bron",
      citycode: "69029",
      context: RHONE,
    },
  ];
  const unfake = installFakes({ ban });
  try {
    const d = upstreamDeps(BAN_URL);
    assert.equal(await d.locate("Parvis Médiathèque, Bron"), "retry");
    assert.ok(ban.calls.some((c) => c.startsWith("/reverse/")));
    ban.reverseStatus = 404;
    await assert.rejects(d.locate("Parvis Médiathèque, Bron"), /BAN reverse 404/);
  } finally {
    unfake();
  }
});

// ---- The command -----------------------------------------------------------------------

const GENERATE = fileURLToPath(new URL("./generate.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

function generate(env: Record<string, string>, cwd = scratch) {
  return spawnSync(process.execPath, ["--import", TSX, GENERATE, "--out", join(scratch, "out")], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
  });
}

test("the API's configuration, if anything loaded it, would stop on the generator's poisoned values", () => {
  const dir = mkdtempSync(join(scratch, "config-"));
  writeFileSync(
    join(dir, ".env"),
    "SUPABASE_URL=http://127.0.0.1:1\nSUPABASE_ANON_KEY=anon\nSUPABASE_SERVICE_ROLE_KEY=service\n",
  );
  const config = fileURLToPath(new URL("../../apps/api/src/config.ts", import.meta.url));
  const isolate = fileURLToPath(new URL("./isolate.ts", import.meta.url));
  const load = (first: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        TSX,
        "--input-type=module",
        "-e",
        [...first, config].map((f) => `await import(${JSON.stringify(f)});`).join(" ") +
          ' console.log("loaded");',
      ],
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        encoding: "utf8",
      },
    );
  // The .env alone is a configuration config.ts takes.
  assert.match(load([]).stdout, /loaded/);
  const poisoned = load([isolate]);
  assert.equal(poisoned.status, 1);
  assert.match(poisoned.stderr, /Configuration invalide/);
  assert.doesNotMatch(poisoned.stdout, /loaded/);
});

test("the command takes its target from the environment only, never a .env, never a service key", () => {
  // A .env where the command runs: the API's configuration would read it, and stop on its URL.
  writeFileSync(
    join(scratch, ".env"),
    "SUPABASE_URL=not a url\nSUPABASE_SERVICE_ROLE_KEY=service\n",
  );
  const none = generate({});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Set PLACE_BACKFILL_URL/);
  assert.doesNotMatch(none.stderr, /Configuration invalide/);

  const service = generate({
    PLACE_BACKFILL_URL: "http://127.0.0.1:1",
    PLACE_BACKFILL_KEY: anonJwt("service_role"),
  });
  assert.equal(service.status, 1);
  assert.match(service.stderr, /PLACE_BACKFILL_KEY is a JWT for the role service_role/);
});
