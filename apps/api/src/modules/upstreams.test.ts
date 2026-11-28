import { strict as assert } from "node:assert";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { BAN_URL, FakeDb, fakeEnv, installFakes } from "../testing/fakes";
import {
  FakeUpstreams,
  heavy,
  installUpstreams,
  late,
  never,
  redirectTo,
  type Service,
} from "../testing/upstreamFakes";

// What the API makes of its third parties — the BAN, geo.api.gouv.fr, Resend,
// Anthropic — when they answer anything but what they document: a redirect,
// a body of any size, values of the wrong type or out of range, late, never.
// And of the database's gateway: a call is sent once, a Retry-After bounded.

const SECRET_BYTES = randomBytes(32);
const cacheDir = await mkdtemp(join(tmpdir(), "ac-upstreams-"));
fakeEnv(cacheDir, {
  EMAIL_MODE: "live",
  RESEND_API_KEY: "re_test",
  ANTHROPIC_API_KEY: "test-key",
  SEND_EMAIL_HOOK_SECRET: `v1,whsec_${SECRET_BYTES.toString("base64")}`,
});
const db = new FakeDb();
const restoreFakes = installFakes({ db });
const up = new FakeUpstreams();
const restoreUpstreams = installUpstreams(up);

const { AnswerTooLargeError } = await import("../lib/cappedFetch");
const { resendPost } = await import("../lib/email/resend");
const { sendVerificationEmails } = await import("../lib/email/verification");
const { adminClient, boundedRetryAfter } = await import("../lib/supabase");
const { byteLrus } = await import("../lib/byteLru");
const { BanAnswerError, banClient } = await import("./geo/ban");
const { forgetHookCalls } = await import("./hooks/routes");
const { resolveTownHall } = await import("./online-testimonies/townHall");
const fr = await import("./places/fr");
const { forgetGeoUnits, upsertGeoUnits } = await import("./places/geoUnits");
const { AnalysisError, analyzeContent, themesOfAnswer } = await import("./testimonies/analysis");
const { AUDITION_THEMES, normalizeTheme, themesOf } = await import("@ac/shared");

let app: FastifyInstance;
before(async () => {
  const { buildServer } = await import("../server");
  app = buildServer();
  await app.ready();
});
after(async () => {
  await app.close();
  restoreUpstreams();
  restoreFakes();
  await rm(cacheDir, { recursive: true, force: true });
});
beforeEach(() => {
  up.reset();
  db.tables = { auditions: [], geo_units: [] };
  db.requests = [];
  db.refuse = () => null;
  forgetGeoUnits();
  forgetHookCalls();
});

const ban = banClient(BAN_URL, 1000);
const ELSEWHERE = "http://elsewhere.test/taken";
const EMAIL = { from: "a@exemple.fr", to: ["temoin@exemple.fr"], subject: "Test", text: "Test" };

/** One call to each of the four clients, with what it makes of the answer set. */
const CLIENTS: Record<Service, () => Promise<unknown>> = {
  ban: () => ban.search("Villeurbanne"),
  geo: () => fr.frChain("38185"),
  resend: () => resendPost("/emails", EMAIL),
  anthropic: () => analyzeContent("Je parle de logement."),
};

// ---- Redirects, sizes ---------------------------------------------------------

test("none of the four clients follows a redirect: the call fails, nothing goes elsewhere", async () => {
  for (const service of Object.keys(CLIENTS) as Service[]) {
    up.answers[service] = () => redirectTo(ELSEWHERE);
    await assert.rejects(CLIENTS[service](), Error, service);
    assert.ok(up.of(service).length > 0, `${service} was asked`);
    assert.ok(
      up.of(service).every((c) => c.redirect === "error"),
      `${service} refuses redirects`,
    );
  }
  assert.deepEqual(up.elsewhere, []);
  // What each caller is told: the commune API and Anthropic as down, not as an answer.
  await assert.rejects(
    CLIENTS.geo(),
    (e: unknown) => e instanceof fr.PlaceError && e.status === 503,
  );
  await assert.rejects(
    CLIENTS.anthropic(),
    (e: unknown) => e instanceof AnalysisError && e.statusCode === 502,
  );
});

test("an answer past the size limit is dropped unread, whoever sent it", async () => {
  // 256 kB for the BAN, the commune API and Resend; 64 kB for the model.
  up.answers.ban = () => heavy(300_000, { features: [] });
  await assert.rejects(ban.search("Lyon"), AnswerTooLargeError);

  up.answers.geo = () => heavy(300_000, { nom: "Grosville", code: "38001" });
  await assert.rejects(fr.frChain("38001"), (e: unknown) => {
    assert.ok(e instanceof fr.PlaceError);
    assert.equal(e.status, 503);
    return true;
  });
  // Nothing of it was kept: the next answer is read.
  up.answers.geo = () =>
    Response.json({
      nom: "Les Abrets en Dauphiné",
      code: "38001",
      departement: { code: "38", nom: "Isère" },
      region: { code: "84", nom: "Auvergne-Rhône-Alpes" },
    });
  assert.equal((await fr.frChain("38001"))?.unit, "fr:com:38001");

  up.answers.resend = () => heavy(300_000, { message: "refused" }, 500);
  await assert.rejects(resendPost("/emails", EMAIL), AnswerTooLargeError);

  up.answers.anthropic = () => heavy(70_000, { content: [{ text: "[]" }] });
  await assert.rejects(
    analyzeContent("x"),
    (e: unknown) => e instanceof AnalysisError && e.statusCode === 502,
  );
  // Under their limits, the same answers are read.
  up.answers.ban = () => heavy(200_000, { features: [] });
  assert.deepEqual(await ban.search("Lyon"), []);
  up.answers.anthropic = () => heavy(50_000, { content: [{ text: '["Logement"]' }] });
  assert.deepEqual(await analyzeContent("x"), ["Logement"]);
});

// ---- Resend ---------------------------------------------------------------------

test("Resend's refusal comes back cut to 300 characters, its status and Retry-After kept", async () => {
  up.answers.resend = () =>
    new Response(JSON.stringify({ message: "E".repeat(200_000) }), {
      status: 429,
      headers: { "retry-after": "7", "content-type": "application/json" },
    });
  const res = await resendPost("/emails", EMAIL);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");
  assert.equal((await res.text()).length, 300);

  // A batch's report carries the refusal once per recipient: each one short.
  const report = await sendVerificationEmails(
    Array.from({ length: 3 }, (_, i) => ({
      email: `temoin-${i}@exemple.fr`,
      personName: "Camille",
      verificationToken: randomUUID(),
    })),
    "Mairie de Lyon",
    "2026-11-22",
  );
  assert.equal(report.failed, 3);
  assert.ok(report.results.every((r) => (r.error ?? "").length === 300));
  assert.ok(JSON.stringify(report).length < 2000);
});

test("an accepted email comes back as Resend answered it", async () => {
  up.answers.resend = () => Response.json({ id: "email-1" });
  const res = await resendPost("/emails", EMAIL, "key-1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "email-1" });
  const [call] = up.of("resend");
  assert.equal(call.headers.get("idempotency-key"), "key-1");
  assert.equal(call.headers.get("authorization"), "Bearer re_test");
});

// ---- The BAN -------------------------------------------------------------------

const feature = (properties: Record<string, unknown>, coordinates: unknown = [4.88, 45.77]) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates },
  properties: {
    score: 0.96,
    type: "municipality",
    name: "Villeurbanne",
    city: "Villeurbanne",
    citycode: "69266",
    postcode: "69100",
    context: "69, Rhône, Auvergne-Rhône-Alpes",
    population: 150000,
    ...properties,
  },
});

test("the BAN's features are read as documented: Corsica, an arrondissement, a collectivité", async () => {
  up.answers.ban = () =>
    Response.json({
      features: [
        feature(
          {
            name: "Ajaccio",
            city: "Ajaccio",
            citycode: "2A004",
            postcode: "20000",
            context: "2A, Corse-du-Sud, Corse",
          },
          [8.7369, 41.9267],
        ),
        feature({ name: "Bastia", city: "Bastia", citycode: "2B033", postcode: "20200" }),
        feature({
          type: "street",
          name: "Rue de Marseille",
          city: "Lyon",
          citycode: "69387",
          postcode: "69007",
        }),
        feature(
          {
            name: "Saint-Pierre",
            city: "Saint-Pierre",
            citycode: "97502",
            postcode: "97500",
            context: "975, Saint-Pierre-et-Miquelon",
            population: null,
          },
          [-56.1773, 46.7811],
        ),
        // The BAN leaves fields out: read as absent.
        { geometry: { coordinates: [2.35, 48.85] }, properties: { name: "Paris", type: "street" } },
      ],
    });
  const found = await ban.search("x");
  assert.deepEqual(
    found.map((f) => [f.name, f.citycode, f.coords]),
    [
      ["Ajaccio", "2A004", [41.9267, 8.7369]],
      ["Bastia", "2B033", [45.77, 4.88]],
      ["Rue de Marseille", "69387", [45.77, 4.88]],
      ["Saint-Pierre", "97502", [46.7811, -56.1773]],
      ["Paris", null, [48.85, 2.35]],
    ],
  );
  assert.equal(found[4].city, null);
  assert.equal(found[4].score, 0);
});

test("a BAN feature that is not one is left out; an answer with none readable is a failed call", async () => {
  const bad: unknown[] = [
    null,
    "feature",
    { geometry: { coordinates: "xy" }, properties: { name: "Lamastre" } },
    feature({}, ["4.34", "44.45"]),
    feature({}, [999, -999]),
    feature({}, [4.88, 95]),
    feature({ citycode: { a: 1 } }),
    feature({ citycode: "0700" }),
    feature({ citycode: "07324; drop" }),
    feature({ city: { toString: 1 } }),
    feature({ city: `<b>Joyeuse</b>${"A".repeat(10_000)}` }),
    feature({ city: "Joyeuse\nParis" }),
    feature({ context: 42 }),
    feature({ population: "many" }),
    feature({ score: "high" }),
    feature({ postcode: "0700A" }),
  ];
  for (const one of bad) {
    up.answers.ban = () => Response.json({ features: [one, feature({ name: "kept" })] });
    const found = await ban.search("x");
    assert.deepEqual(
      found.map((f) => f.name),
      ["kept"],
      JSON.stringify(one).slice(0, 80),
    );
  }
  // Every feature refused: not "no such place" (which would be kept as final).
  up.answers.ban = () => Response.json({ features: bad });
  await assert.rejects(ban.search("x"), BanAnswerError);
  // No feature at all, or no list of them: no such place.
  for (const body of [{ features: [] }, {}, { features: "none" }, null, []]) {
    up.answers.ban = () => Response.json(body);
    assert.deepEqual(await ban.search("x"), []);
  }
  // The nearest address of a point: its fields checked the same way.
  up.answers.ban = () =>
    Response.json({ features: [{ properties: { citycode: "69387", city: "Lyon", context: 7 } }] });
  assert.equal(await ban.reverse([45.7, 4.8]), null);
  up.answers.ban = () =>
    Response.json({ features: [{ properties: { citycode: "69387", city: "Lyon" } }] });
  assert.deepEqual(await ban.reverse([45.7, 4.8]), {
    citycode: "69387",
    city: "Lyon",
    context: null,
  });
});

// ---- geo.api.gouv.fr ----------------------------------------------------------

const point = (lng: number, lat: number) => ({ type: "Point", coordinates: [lng, lat] });
const ARDECHE = { code: "07", nom: "Ardèche" };
const ARA = { code: "84", nom: "Auvergne-Rhône-Alpes" };
/** What geo.api answers for a commune, as asked with the API's `fields`. */
const commune = (code: string, extra: Record<string, unknown> = {}) => ({
  nom: "Aubenas",
  code,
  type: "commune-actuelle",
  zone: "metro",
  departement: ARDECHE,
  region: ARA,
  mairie: point(4.39, 44.62),
  centre: point(4.4, 44.61),
  ...extra,
});
/** The commune API answers each code with what `byCode` holds for it (404 otherwise). */
function communes(byCode: Record<string, unknown>): void {
  up.answers.geo = (call) => {
    const code = decodeURIComponent(/^\/communes\/([^/]+)$/.exec(call.url.pathname)?.[1] ?? "");
    return code in byCode ? Response.json(byCode[code]) : new Response("{}", { status: 404 });
  };
}

test("the commune API's odd codes are all placed: Corsica, arrondissements, communes déléguées, collectivités", async () => {
  const collectivite = (code: string, nom: string, dep: string, depName: string, region = true) =>
    commune(code, {
      nom,
      zone: "com",
      departement: { code: dep, nom: depName },
      // geo.api gives a collectivité itself as its région, or none.
      region: region ? { code: dep, nom: depName } : undefined,
      mairie: undefined,
    });
  communes({
    "2A004": commune("2A004", {
      nom: "Ajaccio",
      departement: { code: "2A", nom: "Corse-du-Sud" },
      region: { code: "94", nom: "Corse" },
    }),
    "2B033": commune("2B033", {
      nom: "Bastia",
      departement: { code: "2B", nom: "Haute-Corse" },
      region: { code: "94", nom: "Corse" },
    }),
    "69387": commune("69387", {
      nom: "Lyon 7e Arrondissement",
      type: "arrondissement-municipal",
      codeParent: "69123",
      departement: { code: "69", nom: "Rhône" },
    }),
    "13201": commune("13201", {
      nom: "Marseille 1er Arrondissement",
      type: "arrondissement-municipal",
      codeParent: "13055",
      departement: { code: "13", nom: "Bouches-du-Rhône" },
      region: { code: "93", nom: "Provence-Alpes-Côte d'Azur" },
    }),
    // A commune déléguée, under the commune nouvelle it joined.
    "49312": commune("49312", {
      nom: "Saint-Philbert-en-Mauges",
      type: "commune-deleguee",
      codeParent: "49023",
      departement: { code: "49", nom: "Maine-et-Loire" },
      region: { code: "52", nom: "Pays de la Loire" },
    }),
    "97105": commune("97105", {
      nom: "Basse-Terre",
      zone: "drom",
      departement: { code: "971", nom: "Guadeloupe" },
      region: { code: "01", nom: "Guadeloupe" },
    }),
    "97502": collectivite("97502", "Saint-Pierre", "975", "Saint-Pierre-et-Miquelon", false),
    "97701": collectivite("97701", "Saint-Barthélemy", "977", "Saint-Barthélemy"),
    "97801": collectivite("97801", "Saint-Martin", "978", "Saint-Martin", false),
    "98613": collectivite("98613", "Uvea", "986", "Wallis-et-Futuna", false),
    "98735": collectivite("98735", "Papeete", "987", "Polynésie française"),
    "98818": collectivite("98818", "Nouméa", "988", "Nouvelle-Calédonie", false),
  });
  const pathOf = async (code: string) => (await fr.frChain(code))?.path;
  assert.deepEqual(await pathOf("2A004"), ["FR", "fr:reg:94", "fr:dep:2A", "fr:com:2A004"]);
  assert.deepEqual(await pathOf("2B033"), ["FR", "fr:reg:94", "fr:dep:2B", "fr:com:2B033"]);
  assert.deepEqual(await pathOf("69387"), [
    "FR",
    "fr:reg:84",
    "fr:dep:69",
    "fr:com:69123",
    "fr:com:69387",
  ]);
  assert.deepEqual(await pathOf("13201"), [
    "FR",
    "fr:reg:93",
    "fr:dep:13",
    "fr:com:13055",
    "fr:com:13201",
  ]);
  assert.deepEqual(await pathOf("49312"), ["FR", "fr:reg:52", "fr:dep:49", "fr:com:49312"]);
  assert.deepEqual(await pathOf("97105"), ["FR", "fr:reg:01", "fr:dep:971", "fr:com:97105"]);
  for (const [code, dep] of [
    ["97502", "975"],
    ["97701", "977"],
    ["97801", "978"],
    ["98613", "986"],
    ["98735", "987"],
    ["98818", "988"],
  ]) {
    assert.deepEqual(
      await pathOf(code),
      ["FR", `fr:reg:${dep}`, `fr:dep:${dep}`, `fr:com:${code}`],
      code,
    );
  }
  // Only the fields read are kept of an answer.
  const kept = await fr.fetchCommune("2A004");
  assert.ok(kept && !("type" in kept));
});

test("a commune answer that is not one is no such code: nothing is made of it, nor asked again at once", async (t) => {
  // Each refusal is said once in the log (places/fr.test.ts reads the line).
  t.mock.method(console, "warn", () => {});
  const refused: Record<string, unknown> = {
    // The label of 10 kB, of several lines, of another type.
    "07101": commune("07101", { nom: `<b>Joyeuse</b>${"B".repeat(10_000)}` }),
    "07102": commune("07102", { nom: "Aubenas\nMairie de Paris" }),
    "07103": commune("07103", { nom: 123 }),
    "07104": commune("07104", { nom: "" }),
    // Another code than the one asked, or no code.
    "07105": commune("07777"),
    "07106": commune("07106", { code: undefined }),
    // A département or a région that does not exist, or not this commune's.
    "07107": commune("07107", { departement: { code: "9Z", nom: "Fausse" } }),
    "07108": commune("07108", { region: { code: "99", nom: "Fausse région" } }),
    "07109": commune("07109", { departement: { code: "69", nom: "Rhône" } }),
    "07110": commune("07110", { departement: { code: "07", nom: "A".repeat(101) } }),
    // Points outside the globe, or that are not points.
    "07111": commune("07111", { mairie: point(999, 999) }),
    "07112": commune("07112", { centre: point(4.4, -91) }),
    "07113": commune("07113", { centre: { type: "Point", coordinates: ["4.4", "44.6"] } }),
    "07114": commune("07114", { mairie: "45.76,4.83" }),
    // An arrondissement filed under another commune than its city.
    "69388": commune("69388", {
      nom: "Lyon 8e Arrondissement",
      codeParent: "07019",
      departement: { code: "69", nom: "Rhône" },
    }),
    "07115": "Aubenas",
    "07116": [commune("07116")],
    "07117": null,
  };
  communes(refused);
  for (const code of Object.keys(refused)) {
    assert.equal(await fr.frChain(code), null, code);
    const asked = up.of("geo").length;
    assert.equal(await fr.frChain(code), null, code);
    assert.equal(up.of("geo").length, asked, `${code}: kept as unknown for a while`);
  }
  // The public form's town hall: no label is ever made of such an answer.
  communes({ "07118": commune("07118", { nom: `Fauxville${"C".repeat(200)}` }) });
  await assert.rejects(resolveTownHall("07118"), (e: unknown) => {
    assert.ok(e instanceof fr.PlaceError);
    assert.equal(e.status, 400);
    assert.equal(e.message, "Commune introuvable : choisissez-la dans la liste.");
    return true;
  });
  // A commune answered without its département has no town hall to name.
  communes({ "07119": commune("07119", { departement: undefined, region: undefined }) });
  await assert.rejects(
    resolveTownHall("07119"),
    (e: unknown) => e instanceof fr.PlaceError && e.status === 400,
  );
  // And a whole answer: the label, the département's code in it.
  communes({ "07019": commune("07019") });
  const hall = await resolveTownHall("07019");
  assert.equal(hall.location, "Mairie d'Aubenas (07)");
  assert.deepEqual(hall.chain?.path, ["FR", "fr:reg:84", "fr:dep:07", "fr:com:07019"]);
});

test("départements and régions: the code asked, of those that exist", async (t) => {
  t.mock.method(console, "warn", () => {});
  up.answers.geo = (call) => {
    if (call.url.pathname === "/departements/07") {
      return Response.json({ nom: "Ardèche", code: "07", region: ARA });
    }
    // Asked for 26, answered about another département; 9Z does not exist.
    if (call.url.pathname === "/departements/26") {
      return Response.json({ nom: "Ardèche", code: "07", region: ARA });
    }
    if (call.url.pathname === "/departements/38") {
      return Response.json({ nom: "Isère", code: "38", region: { code: "99", nom: "Fausse" } });
    }
    if (call.url.pathname === "/regions") {
      return Response.json([
        { nom: "Bretagne", code: "53" },
        { nom: "Fausse région", code: "99" },
      ]);
    }
    return new Response("{}", { status: 404 });
  };
  assert.deepEqual((await fr.frDepartementChain("07"))?.path, ["FR", "fr:reg:84", "fr:dep:07"]);
  assert.equal(await fr.frDepartementChain("26"), null);
  assert.equal(await fr.frDepartementChain("38"), null);
  // One made-up région in the list: the list is not one.
  assert.equal(await fr.frRegionChain("Bretagne"), null);
  assert.equal(await fr.frRegionChain("Fausse région"), null);
});

test("the commune answers kept are bounded: 2,000 entries, 8 MB, the least recently read first out", async () => {
  const store = byteLrus().find((l) => l.name === "geo-api");
  assert.ok(store);
  assert.equal(store.maxBytes, 8 * 1024 * 1024);
  const names: Record<string, string> = { "01": "Ain", "02": "Aisne", "03": "Allier" };
  up.answers.geo = (call) => {
    const code = call.url.pathname.split("/")[2];
    const dep = code.slice(0, 2);
    // 100 kB the API never reads ride along: not kept.
    return Response.json(
      commune(code, { departement: { code: dep, nom: names[dep] }, pad: "x".repeat(100_000) }),
    );
  };
  const codes = Object.keys(names).flatMap((dep) =>
    Array.from({ length: 800 }, (_, i) => `${dep}${String(i).padStart(3, "0")}`),
  );
  const before = store.stats().bytes;
  for (const code of codes.slice(0, 500)) assert.ok(await fr.fetchCommune(code), code);
  // 50 MB went by on the wire: what is kept of it is a few kB an answer.
  assert.ok(store.stats().bytes - before < 500 * 5000, `${store.stats().bytes - before}`);
  for (const code of codes.slice(500)) await fr.fetchCommune(code);
  const full = store.stats();
  assert.ok(full.entries <= 2000, `${full.entries} entries`);
  assert.ok(full.bytes <= full.maxBytes);
  assert.ok(full.evictions > 0);
  // The first read went first: asked again, it is fetched again; the last is still held.
  const asked = up.of("geo").length;
  await fr.fetchCommune(codes[0]);
  assert.equal(up.of("geo").length, asked + 1);
  await fr.fetchCommune(codes[codes.length - 1]);
  assert.equal(up.of("geo").length, asked + 1);
});

// ---- geo_units ---------------------------------------------------------------

test("a unit already stored follows the same unit arriving from a newer release, and only then", async () => {
  const base = {
    parent_id: "fr:dep:07",
    level: "locality",
    country: "FR",
    source: "insee",
  } as const;
  db.insert("geo_units", [
    { id: "FR", parent_id: null, level: "country", country: "FR", name: "France" },
    { id: "fr:dep:07", parent_id: "FR", level: "county", country: "FR", name: "Ardèche" },
    {
      ...base,
      id: "fr:com:07324",
      name: "Joyeuse (ancien nom)",
      code: "07324",
      lat: 48.85,
      lng: 2.35,
      geo_release: "geoapi-2025",
    },
    {
      ...base,
      id: "fr:com:07019",
      name: "Aubenas (ancien nom)",
      code: "07019",
      lat: 44.6,
      lng: 4.4,
      geo_release: "geoapi-2026",
    },
    {
      ...base,
      id: "fr:com:07010",
      name: "D'une autre source",
      code: "07010",
      lat: 1,
      lng: 1,
      source: "overture",
      geo_release: "2024-01-01.0",
    },
    {
      ...base,
      id: "fr:com:07186",
      name: "Privas",
      code: "07186",
      lat: 44.73,
      lng: 4.6,
      geo_release: "geoapi-2025",
    },
  ]);
  const arriving = (id: string, name: string, lat: number | null, lng: number | null) => ({
    ...base,
    id,
    name,
    code: id.slice(-5),
    lat,
    lng,
    geo_release: "geoapi-2026",
  });
  await upsertGeoUnits([
    arriving("fr:com:07324", "Joyeuse", 44.479, 4.238),
    arriving("fr:com:07019", "Aubenas", 44.62, 4.39),
    arriving("fr:com:07010", "Alba-la-Romaine", 44.55, 4.6),
    arriving("fr:com:07186", "Privas (nouveau)", null, null),
    arriving("fr:com:07330", "Vals-les-Bains", 44.66, 4.36),
  ]);
  const unit = (id: string) => db.tables.geo_units.find((u) => u.id === id)!;
  // An older release: its name and point are the arriving unit's.
  assert.deepEqual(
    [unit("fr:com:07324").name, unit("fr:com:07324").lat, unit("fr:com:07324").geo_release],
    ["Joyeuse", 44.479, "geoapi-2026"],
  );
  // The same release, another source: as stored.
  assert.equal(unit("fr:com:07019").name, "Aubenas (ancien nom)");
  assert.equal(unit("fr:com:07010").name, "D'une autre source");
  // Arriving without a point: the stored one stays.
  assert.deepEqual(
    [unit("fr:com:07186").name, unit("fr:com:07186").lat],
    ["Privas (nouveau)", 44.73],
  );
  // One not there yet is inserted, as before.
  assert.equal(unit("fr:com:07330").name, "Vals-les-Bains");
  // Written once per process: the same units again ask nothing.
  const asked = db.requests.length;
  await upsertGeoUnits([arriving("fr:com:07324", "Joyeuse", 44.479, 4.238)]);
  assert.equal(db.requests.length, asked);
});

// ---- The Send Email hook -----------------------------------------------------

function hookCall(type: string, id: string = randomUUID(), extra: Record<string, unknown> = {}) {
  const payload = JSON.stringify({
    user: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", email: "testeur@exemple.fr", ...extra },
    email_data: {
      token: "123456",
      token_hash: "hash-main",
      redirect_to: "http://localhost:5173/admin",
      email_action_type: type,
      site_url: "http://localhost:5173",
      token_new: "654321",
      token_hash_new: type === "email_change" ? "hash-current" : "",
    },
  });
  const sentAt = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", SECRET_BYTES)
    .update(`${id}.${sentAt}.${payload}`)
    .digest("base64");
  return {
    method: "POST" as const,
    url: "/api/hooks/send-email",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": sentAt,
      "webhook-signature": `v1,${signature}`,
    },
    payload,
  };
}

test("the hook: the same signed call again sends nothing; its webhook-id is Resend's key", async () => {
  up.answers.resend = () => Response.json({ id: "email-1" });
  const call = hookCall("recovery", "msg_1");
  for (let i = 0; i < 3; i++) {
    const res = await app.inject(call);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {});
  }
  assert.equal(up.of("resend").length, 1, "three identical calls, one email");
  assert.equal(up.of("resend")[0].headers.get("idempotency-key"), "auth-msg_1");
  // Another call is another email.
  assert.equal((await app.inject(hookCall("recovery", "msg_2"))).statusCode, 200);
  assert.equal(up.of("resend").length, 2);
  // The same call twice at once: one send, both answered.
  const twin = hookCall("signup", "msg_3");
  up.answers.resend = late(50, () => Response.json({ id: "email-3" }));
  const both = await Promise.all([app.inject(twin), app.inject(twin)]);
  assert.deepEqual(
    both.map((r) => r.statusCode),
    [200, 200],
  );
  assert.equal(up.of("resend").length, 3);
});

test("the hook: a call whose email did not leave is not remembered — sent again, it is tried again", async () => {
  up.answers.resend = () => Response.json({ message: "quota" }, { status: 429 });
  const call = hookCall("recovery", "msg_failed");
  const failed = await app.inject(call);
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().error.message, "L'email n'a pas pu être envoyé.");
  up.answers.resend = () => Response.json({ id: "email-1" });
  assert.equal((await app.inject(call)).statusCode, 200);
  assert.equal(up.of("resend").length, 2);
  assert.equal(up.of("resend")[1].headers.get("idempotency-key"), "auth-msg_failed");
});

test("the hook: an email change's two emails leave together, each under its own key", async () => {
  // Resend answers neither before it holds both: one after the other, the second would never come.
  let release!: () => void;
  const bothAsked = new Promise<void>((resolve) => (release = resolve));
  up.answers.resend = async () => {
    if (up.of("resend").length === 2) release();
    await bothAsked;
    return Response.json({ id: "email" });
  };
  const res = await app.inject(
    hookCall("email_change", "msg_change", { new_email: "nouvelle@exemple.fr" }),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    up
      .of("resend")
      .map((c) => [
        (JSON.parse(c.body) as { to: string[] }).to[0],
        c.headers.get("idempotency-key"),
      ]),
    [
      ["testeur@exemple.fr", "auth-msg_change"],
      ["nouvelle@exemple.fr", "auth-msg_change-2"],
    ],
  );
  // One of the two refused: the call failed, and is not remembered.
  up.reset();
  up.answers.resend = (c) =>
    (JSON.parse(c.body) as { to: string[] }).to[0] === "nouvelle@exemple.fr"
      ? Response.json({ message: "refused" }, { status: 429 })
      : Response.json({ id: "email" });
  const half = hookCall("email_change", "msg_half", { new_email: "nouvelle@exemple.fr" });
  assert.equal((await app.inject(half)).statusCode, 500);
  up.answers.resend = () => Response.json({ id: "email" });
  assert.equal((await app.inject(half)).statusCode, 200);
});

test("the hook answers within Auth's 5 s whatever Resend does: one 4 s deadline for the call", async () => {
  // Resend never answers the recovery and the email change, and accepts the
  // sign-up email half a second past the deadline.
  let landed = 0;
  const lateAnswer = late(4500, () => {
    landed++;
    return Response.json({ id: "late" });
  });
  up.answers.resend = (call, signal) =>
    (JSON.parse(call.body) as { subject: string }).subject === "Confirmez votre adresse email"
      ? lateAnswer(call, signal)
      : never(call, signal);
  const started = Date.now();
  const answers = await Promise.all(
    [
      hookCall("recovery"),
      hookCall("email_change", undefined, { new_email: "nouvelle@exemple.fr" }),
      hookCall("signup"),
    ].map(async (call) => ({
      status: (await app.inject(call)).statusCode,
      took: Date.now() - started,
    })),
  );
  for (const { status, took } of answers) {
    assert.equal(status, 500);
    assert.ok(took >= 3900 && took < 4800, `answered after ${took} ms`);
  }
  // The recovery, the two of the email change, the sign-up.
  assert.equal(up.of("resend").length, 4);
  // Past the deadline a call is ended, not left to land after Auth was told it failed.
  await sleep(800);
  assert.equal(landed, 0);
});

// ---- The database's gateway ----------------------------------------------------

test("a call to the database is sent once: a 503 is its caller's to handle", async () => {
  db.tables.user_roles = [];
  db.refuse = (method) =>
    method === "GET" ? { status: 503, code: "PGRST002", message: "schema cache" } : null;
  const { error } = await adminClient.from("user_roles").select("role");
  assert.ok(error);
  assert.equal(db.requests.length, 1);
});

test("a gateway's Retry-After is brought down to 5 s", async () => {
  const answering = (retryAfter: string | null) =>
    boundedRetryAfter(
      async () =>
        new Response("busy", {
          status: 503,
          headers: retryAfter === null ? {} : { "retry-after": retryAfter },
        }),
    )("http://supabase.test/rest/v1/x");
  assert.equal((await answering("100000")).headers.get("retry-after"), "5");
  assert.equal((await answering("6")).headers.get("retry-after"), "5");
  assert.equal((await answering("100000 seconds")).headers.get("retry-after"), "5");
  assert.equal((await answering("5")).headers.get("retry-after"), "5");
  assert.equal((await answering("2")).headers.get("retry-after"), "2");
  assert.equal((await answering(null)).headers.get("retry-after"), null);
  const bounded = await answering("100000");
  assert.equal(bounded.status, 503);
  assert.equal(await bounded.text(), "busy");
});

// ---- The analysis ----------------------------------------------------------------

test("of a model answer only the grid's themes are kept: each once, 16 at most", () => {
  assert.deepEqual(themesOfAnswer('["Logement", "Retraites"]'), ["Logement", "Retraites"]);
  // In the grid's order, each once, whatever the answer's order and repeats.
  assert.deepEqual(themesOfAnswer('Voici : ["Retraites","Logement","Retraites"] — fin'), [
    "Logement",
    "Retraites",
  ]);
  // Anything that is not a theme's name is left out, whatever its type.
  assert.deepEqual(
    themesOfAnswer(
      JSON.stringify([
        1,
        2.5,
        true,
        null,
        ["Fiscalité"],
        { a: 1 },
        "<b>Joyeuse</b>",
        "Thème libre",
        "Fiscalité",
      ]),
    ),
    ["Fiscalité"],
  );
  // A tag of the older vocabulary is stored as its theme of the grid.
  assert.deepEqual(themesOfAnswer('["écologie", "santé"]'), [
    "Santé et accès aux soins",
    "Environnement et écologie",
  ]);
  // However long the list: nothing of it but the grid.
  const flood = Array.from({ length: 5000 }, (_, i) => `Thème ${i} ${"z".repeat(200)}`);
  assert.deepEqual(themesOfAnswer(JSON.stringify(flood)), []);
  assert.deepEqual(
    themesOfAnswer(JSON.stringify([...flood, ...AUDITION_THEMES, ...AUDITION_THEMES])),
    [...AUDITION_THEMES],
  );
  // No list, or one that is not JSON: the grid's names the text spells, if any.
  assert.deepEqual(themesOfAnswer("Aucun thème."), []);
  assert.deepEqual(themesOfAnswer("[Logement, puis les retraites]"), ["Logement", "Retraites"]);
  assert.deepEqual(themesOfAnswer('{"themes": "Logement"}'), []);
});

test("the analysis: an answer that is not one is a 502, a slow one a 504, never a 500", async () => {
  const refused = async (answer: () => Response, status: number) => {
    up.answers.anthropic = answer;
    await assert.rejects(analyzeContent("Je parle de logement."), (e: unknown) => {
      assert.ok(e instanceof AnalysisError, String(e));
      assert.equal(e.statusCode, status);
      return true;
    });
  };
  await refused(() => Response.json({ content: "text" }), 502);
  await refused(() => Response.json({ content: [{ text: { a: 1 } }] }), 502);
  await refused(() => Response.json({ content: [] }), 502);
  await refused(() => Response.json(null), 502);
  await refused(() => new Response("<html>It works!</html>", { status: 200 }), 502);
  await refused(() => Response.json({ error: "overloaded" }, { status: 529 }), 502);
  await refused(() => Response.json({ error: "rate" }, { status: 429 }), 429);
  // The time limit covers the answer's reading: an abort while it comes is a 504.
  up.answers.anthropic = () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  await assert.rejects(
    analyzeContent("x"),
    (e: unknown) => e instanceof AnalysisError && e.statusCode === 504,
  );
  up.answers.anthropic = () =>
    Response.json({ content: [{ text: '["Logement", 7, "Éducation", null]' }] });
  assert.deepEqual(await analyzeContent("x"), ["Éducation", "Logement"]);
  const [call] = up.of("anthropic").slice(-1);
  assert.equal(call.headers.get("x-api-key"), "test-key");
});

test("themesOf and normalizeTheme read anything a topics array may hold", () => {
  const anything = [null, 1, 2.5, true, ["Logement"], { a: 1 }, undefined, "Logement", "climat"];
  assert.deepEqual(themesOf(anything as string[]), ["Logement", "Environnement et écologie"]);
  for (const item of anything.slice(0, 7)) assert.equal(normalizeTheme(item as string), null);
  assert.deepEqual(themesOf([null] as unknown as string[]), []);
  // Text is read as before.
  assert.deepEqual(normalizeTheme("Logement"), { theme: "Logement", match: "canonical" });
  assert.deepEqual(normalizeTheme("logement"), { theme: "Logement", match: "exact" });
  assert.deepEqual(normalizeTheme("solidarité"), {
    theme: "Justice sociale et inégalités",
    match: "approx",
  });
  assert.equal(normalizeTheme("ruralité"), null);
  // However many unknown tags are read, known ones still resolve.
  for (let i = 0; i < 3000; i++) assert.equal(normalizeTheme(`inconnu ${i}`), null);
  assert.deepEqual(normalizeTheme("Démocratie"), {
    theme: "Démocratie et institutions",
    match: "exact",
  });
});
