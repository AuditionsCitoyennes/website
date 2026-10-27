import { test } from "node:test";
import assert from "node:assert/strict";
import { FR_DEPARTMENTS } from "./frDepartments";
import {
  isHomonyms,
  locate,
  placementOf,
  settleHomonyms,
  type BanFeature,
  type BanSearch,
  type GeoEntry,
  type Located,
} from "./match";

// `npm test` in apps/api. BAN is faked: each test says what it answers, the
// shapes are BAN's (answers trimmed from real ones, 2026-10-21).

type Fake = { municipality?: Record<string, BanFeature[]>; address?: Record<string, BanFeature[]> };

function fakeBan(answers: Fake): BanSearch & { calls: string[] } {
  const calls: string[] = [];
  const search = (async (q, opts) => {
    calls.push(`${opts?.municipality ? "municipality" : "address"}:${q}`);
    return (opts?.municipality ? answers.municipality : answers.address)?.[q] ?? [];
  }) as BanSearch & { calls: string[] };
  search.calls = calls;
  return search;
}

function commune(
  name: string,
  citycode: string,
  context: string,
  population: number,
  coords: [number, number] = [45, 5],
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

function street(
  name: string,
  city: string,
  citycode: string,
  context: string,
  score: number,
  coords: [number, number] = [45.1, 5.1],
): BanFeature {
  return {
    coords,
    score,
    type: "street",
    name,
    city,
    citycode,
    postcode: null,
    context,
    population: null,
  };
}

const RHONE = "69, Rhône, Auvergne-Rhône-Alpes";
const HAUTES_ALPES = "05, Hautes-Alpes, Provence-Alpes-Côte d'Azur";
const LYON = commune("Lyon", "69123", RHONE, 519127, [45.758, 4.835]);
const SAINT_DENIS = [
  commune("Saint-Denis", "97411", "974, La Réunion", 155634),
  commune("Saint-Denis", "93066", "93, Seine-Saint-Denis, Île-de-France", 149077),
  commune("Saint-Denis", "11339", "11, Aude, Occitanie", 523),
];

function placed(v: Located): GeoEntry {
  assert.ok(v && !isHomonyms(v), `expected one place, got ${JSON.stringify(v)}`);
  return v;
}

test("a bare name is a commune only if one has exactly that name", async () => {
  // BAN's best municipality for "Lima" is Limas (Rhône); for "Berlin", Berling.
  const ban = fakeBan({
    municipality: {
      Lima: [
        commune("Limas", "69115", RHONE, 4750),
        commune("Limay", "78335", "78, Yvelines, Île-de-France", 17885),
      ],
      Berlin: [commune("Berling", "57064", "57, Moselle, Grand Est", 313)],
    },
    // The lieu-dit "Berlin" of Ariège is a strong address match: never asked.
    address: { Berlin: [street("Berlin", "Saint-Ybars", "09277", "09, Ariège, Occitanie", 0.86)] },
  });
  assert.equal(await locate("Lima", ban), null);
  assert.equal(await locate("Berlin", ban), null);
  assert.deepEqual(ban.calls, ["municipality:Lima", "municipality:Berlin"]);
});

test("names compare without case, accents, hyphens, and with St spelled out", async () => {
  const ban = fakeBan({
    municipality: {
      "La Tour-Du-Pin": [
        commune("La Tour-du-Pin", "38509", "38, Isère, Auvergne-Rhône-Alpes", 8111),
      ],
      "Saint Etienne": [
        commune("Saint-Étienne", "42218", "42, Loire, Auvergne-Rhône-Alpes", 170000),
      ],
    },
  });
  assert.equal(placed(await locate("La Tour-Du-Pin", ban)).citycode, "38509");
  assert.equal(placed(await locate("St Etienne", ban)).citycode, "42218");
});

test("a département or région name is placed at that level, at its centre", async () => {
  const ban = fakeBan({
    municipality: {
      // What BAN offered before: a commune whose name merely contains it.
      "Hautes-Alpes": [commune("Châteauroux-les-Alpes", "05036", HAUTES_ALPES, 1234)],
    },
  });
  const hautesAlpes = placed(await locate("Hautes-Alpes", ban));
  assert.equal(hautesAlpes.level, "departement");
  assert.deepEqual(hautesAlpes.coords, FR_DEPARTMENTS["05"].centre);
  assert.deepEqual(
    { city: hautesAlpes.city, citycode: hautesAlpes.citycode, depCode: hautesAlpes.depCode },
    { city: null, citycode: null, depCode: "05" },
  );
  assert.equal(placed(await locate("Département de l'Ardèche", ban)).depCode, "07");
  const paca = placed(await locate("PACA", ban));
  assert.deepEqual(
    [paca.level, paca.depCode, paca.region],
    ["region", null, "Provence-Alpes-Côte d'Azur"],
  );
});

test("a name both a town and an area is the town only if it is a town", async () => {
  const ban = fakeBan({
    municipality: {
      Vienne: [commune("Vienne", "38544", "38, Isère, Auvergne-Rhône-Alpes", 31778)],
      Corrèze: [commune("Corrèze", "19062", "19, Corrèze, Nouvelle-Aquitaine", 1171)],
      "La Réunion": [commune("La Réunion", "47222", "47, Lot-et-Garonne, Nouvelle-Aquitaine", 524)],
    },
  });
  assert.equal(placed(await locate("Vienne", ban)).citycode, "38544");
  assert.equal(placed(await locate("Corrèze", ban)).level, "departement");
  assert.equal(placed(await locate("La Réunion", ban)).depCode, "974");
});

test("overseas communes are placed, with their région", async () => {
  const ban = fakeBan({
    municipality: {
      "Fort-de-France": [
        commune("Fort-de-France", "97209", "972, Martinique", 75506, [14.6478, -61.0621]),
      ],
    },
  });
  const fdf = placed(await locate("Fort-de-France", ban));
  assert.deepEqual(
    [fdf.citycode, fdf.depCode, fdf.depName, fdf.region],
    ["97209", "972", "Martinique", "Martinique"],
  );
});

test("“X, Département” is the commune X of that département", async () => {
  const ban = fakeBan({
    municipality: {
      "La Réunion": [commune("La Réunion", "47222", "47, Lot-et-Garonne, Nouvelle-Aquitaine", 524)],
      "Saint-Pierre": [
        commune("Saint-Pierre", "97416", "974, La Réunion", 85038),
        commune("Saint-Pierre", "97225", "972, Martinique", 3961),
        commune("Saint-Pierre", "39494", "39, Jura, Bourgogne-Franche-Comté", 383),
      ],
      Châteauvieux: [
        commune("Châteauvieux", "05037", HAUTES_ALPES, 545),
        commune("Châteauvieux", "41042", "41, Loir-et-Cher, Centre-Val de Loire", 514),
      ],
      Gap: [commune("Gap", "05061", HAUTES_ALPES, 41293)],
    },
  });
  assert.equal(placed(await locate("Saint-Pierre, La Réunion", ban)).citycode, "97416");
  assert.equal(placed(await locate("Châteauvieux (05)", ban)).citycode, "05037");
  // A bare code is a département only as the trailing context, and never sent to BAN.
  assert.equal(placed(await locate("Gap, 05", ban)).citycode, "05061");
  assert.ok(!ban.calls.includes("municipality:05"));
  // Nothing by that name there: the département itself.
  const market = placed(await locate("Place du Marché, Hautes-Alpes", ban));
  assert.deepEqual([market.level, market.depCode], ["departement", "05"]);
});

test("“X, Commune” is BAN's point only inside that commune, and only a strong one", async () => {
  const ban = fakeBan({
    municipality: {
      Lyon: [LYON],
      Bron: [commune("Bron", "69029", RHONE, 42000, [45.7355, 4.9112])],
      "Lyon 8e Arrondissement": [
        {
          ...commune("Lyon 8e Arrondissement", "69388", RHONE, 85943, [45.734, 4.87]),
          city: "Lyon",
        },
      ],
    },
    address: {
      "Les États-Unis, Lyon": [
        street("Boulevard des Etats-Unis", "Lyon", "69388", RHONE, 0.61, [45.7314, 4.8661]),
      ],
      // BAN's best is a namesake square in Lyon 9e.
      "Place Ferber, Bron": [street("Place Ferber", "Lyon", "69389", RHONE, 0.62)],
      "Parvis de la MJC, Lyon 8": [
        street("Boulevard des Etats-Unis", "Lyon", "69388", RHONE, 0.34),
      ],
    },
  });
  const usa = placed(await locate("Les États-Unis, Lyon", ban));
  assert.deepEqual(
    [usa.level, usa.city, usa.citycode, usa.arrondissement, usa.coords],
    ["address", "Lyon", "69388", "Lyon 8e", [45.7314, 4.8661]],
  );
  const ferber = placed(await locate("Place Ferber, Bron", ban));
  assert.deepEqual(
    [ferber.level, ferber.citycode, ferber.coords],
    ["commune", "69029", [45.7355, 4.9112]],
  );
  // A weak match within the arrondissement: the arrondissement, filed under Lyon.
  const mjc = placed(await locate("Parvis de la MJC, Lyon 8", ban));
  assert.deepEqual(
    [mjc.level, mjc.city, mjc.citycode, mjc.arrondissement],
    ["commune", "Lyon", "69388", "Lyon 8e"],
  );
});

test("“City, Country” is abroad, even when a commune bears the country's name", async () => {
  const MOSELLE = "57, Moselle, Grand Est";
  const HAUTE_GARONNE = "31, Haute-Garonne, Occitanie";
  const LOIRE_ATLANTIQUE = "44, Loire-Atlantique, Pays de la Loire";
  const ban = fakeBan({
    municipality: {
      Suisse: [commune("Suisse", "57662", MOSELLE, 94, [48.966294, 6.578961])],
      Argentine: [
        commune("Argentine", "73019", "73, Savoie, Auvergne-Rhône-Alpes", 959),
        commune("La Rochebeaucourt-et-Argentine", "24353", "24, Dordogne, Nouvelle-Aquitaine", 331),
      ],
      Grenade: [
        commune("Grenade", "31232", HAUTE_GARONNE, 9062, [43.764143, 1.289286]),
        commune("Grenade-sur-l'Adour", "40117", "40, Landes, Nouvelle-Aquitaine", 2398),
      ],
      Soudan: [
        commune("Soudan", "44199", LOIRE_ATLANTIQUE, 1959),
        commune("Soudan", "79316", "79, Deux-Sèvres, Nouvelle-Aquitaine", 424),
      ],
      Villeurbanne: [commune("Villeurbanne", "69266", RHONE, 156928)],
      Serres: [
        commune("Serres", "05166", HAUTES_ALPES, 1298),
        commune("Serres", "54502", "54, Meurthe-et-Moselle, Grand Est", 254),
      ],
    },
    address: {
      // Inside the commune, but weak, and no place the text names.
      "Khartoum, Soudan": [street("la Gare", "Soudan", "44199", LOIRE_ATLANTIQUE, 0.326)],
      "Port-Soudan, Soudan": [street("Landasson", "Soudan", "44199", LOIRE_ATLANTIQUE, 0.409)],
      "Saint-Georges, Grenade": [
        street("Route de Saint-Jory", "Grenade", "31232", HAUTE_GARONNE, 0.366),
      ],
      // Strong, inside, but a street the text does not name: no place of it.
      "Zurich, Suisse": [street("Rue de la Gare", "Suisse", "57662", MOSELLE, 0.62)],
      // The street the text names, inside the commune: that point.
      "Rue de la Gare, Suisse": [
        street("Rue de la Gare", "Suisse", "57662", MOSELLE, 0.88, [48.9671, 6.5794]),
      ],
    },
  });
  // Never a guess: unplaced, with no same-named communes to settle against
  // the other lieux (Soudan: Loire-Atlantique or Deux-Sèvres).
  for (const text of [
    "Berne, Suisse",
    "Genève, Suisse",
    "Lausanne, Suisse",
    "Zurich, Suisse",
    "Buenos Aires, Argentine",
    "Córdoba, Argentine",
    "Mendoza, Argentine",
    "Rosario, Argentine",
    "Gouyave, Grenade",
    "Saint-Georges, Grenade",
    "Khartoum, Soudan",
    "Omdurman, Soudan",
    "Port-Soudan, Soudan",
  ]) {
    assert.equal(await locate(text, ban), null, text);
  }
  const gare = placed(await locate("Rue de la Gare, Suisse", ban));
  assert.deepEqual(
    [gare.level, gare.citycode, gare.coords],
    ["address", "57662", [48.9671, 6.5794]],
  );
  // An area says the French commune is meant; a bare name is the commune.
  assert.equal(placed(await locate("Gouyave, Grenade (31)", ban)).citycode, "31232");
  assert.equal(placed(await locate("Gouyave, Grenade, Haute-Garonne", ban)).citycode, "31232");
  assert.equal(placed(await locate("Grenade", ban)).citycode, "31232");
  // Communes that are no country keep "X, Commune" and "Ville, Département".
  const salle = placed(await locate("Salle des fêtes, Villeurbanne", ban));
  assert.deepEqual([salle.level, salle.citycode], ["commune", "69266"]);
  assert.equal(placed(await locate("Serres, Hautes-Alpes", ban)).citycode, "05166");
});

test("a lieu with no commune named stands only if it reads as one sure address", async () => {
  const ban = fakeBan({
    address: {
      "Place Bellecour": [
        street("Place Bellecour", "Lyon", "69382", RHONE, 0.95),
        street("Place Bellecour", "Lyon", "69382", RHONE, 0.82),
      ],
      "Place de la République": [
        street("Place de la République", "Paris", "75111", "75, Paris, Île-de-France", 0.89),
        street("Place de la République", "Lyon", "69382", RHONE, 0.88),
      ],
    },
  });
  assert.equal(placed(await locate("Place Bellecour", ban)).citycode, "69382");
  assert.equal(await locate("Place de la République", ban), null);
});

test("same-named communes are kept as candidates, then settled against the other lieux", async () => {
  const ban = fakeBan({
    municipality: { "Saint-Denis": SAINT_DENIS },
    address: {
      "Place de la Basilique, Saint-Denis": [
        street(
          "Place de la Basilique",
          "Saint-Denis",
          "93066",
          "93, Seine-Saint-Denis, Île-de-France",
          0.9,
        ),
      ],
    },
  });
  const bare = await locate("Saint-Denis", ban);
  assert.ok(isHomonyms(bare));
  assert.deepEqual(
    bare.homonyms.map((h) => h.citycode),
    ["97411", "93066", "11339"],
  );
  // Réunion's and Seine-Saint-Denis's are nearly as big: no guess.
  assert.equal(settleHomonyms(new Map([["Saint-Denis", bare]])).get("Saint-Denis"), null);

  // Where the association already holds lieux (three or more), that one.
  const in93 = (n: number): [string, Located][] =>
    Array.from({ length: n }, (_, i) => [
      `Lieu ${i}`,
      {
        ...SAINT_DENIS[1],
        coords: [48.9, 2.3],
        citycode: "93066",
        depCode: "93",
        depName: "Seine-Saint-Denis",
        region: "Île-de-France",
        city: "Saint-Denis",
        arrondissement: null,
        level: "address",
      },
    ]);
  assert.equal(
    settleHomonyms(new Map([["Saint-Denis", bare], ...in93(2)])).get("Saint-Denis"),
    null,
  );
  assert.equal(
    settleHomonyms(new Map([["Saint-Denis", bare], ...in93(3)])).get("Saint-Denis")?.citycode,
    "93066",
  );

  // The street exists in only one of them: that one.
  const basilique = placed(await locate("Place de la Basilique, Saint-Denis", ban));
  assert.deepEqual([basilique.level, basilique.citycode], ["address", "93066"]);
});

test("a commune far bigger than every namesake is the one meant", async () => {
  const ban = fakeBan({
    municipality: {
      Serres: [
        commune("Serres", "05166", HAUTES_ALPES, 1298),
        commune("Serres", "54502", "54, Meurthe-et-Moselle, Grand Est", 254),
        commune("Serres", "11377", "11, Aude, Occitanie", 89),
      ],
    },
  });
  const settled = settleHomonyms(new Map([["Serres", await locate("Serres", ban)]]));
  const serres = settled.get("Serres");
  assert.equal(serres?.citycode, "05166");
  assert.ok(serres && !("population" in serres), "a settled entry is a plain GeoEntry");
});

test("the admins are told how a lieu is placed, and why one is not", async () => {
  const ban = fakeBan({
    municipality: {
      "Saint-Denis": SAINT_DENIS,
      Serres: [
        commune("Serres", "05166", HAUTES_ALPES, 1298),
        commune("Serres", "54502", "54, Meurthe-et-Moselle, Grand Est", 254),
      ],
      Ribiers: [],
    },
  });
  const located = new Map<string, Located>([
    ["Saint-Denis", await locate("Saint-Denis", ban)],
    ["Serres", await locate("Serres", ban)],
    ["Hautes-Alpes", await locate("Hautes-Alpes", ban)],
    ["Ribiers", await locate("Ribiers", ban)],
  ]);
  const settled = settleHomonyms(located);
  const told = (name: string) => placementOf(located.get(name), settled.get(name));

  assert.deepEqual(placementOf(undefined, undefined), { placement: "pending" });
  assert.deepEqual(told("Ribiers"), { placement: "unplaced" });
  assert.deepEqual(told("Hautes-Alpes"), { placement: "departement" });
  // Settled by population: placed, the namesakes no longer matter.
  assert.deepEqual(told("Serres"), { placement: "commune" });
  // Not settled: the communes it could be, as an admin would write them.
  assert.deepEqual(told("Saint-Denis"), {
    placement: "unplaced",
    candidates: [
      { name: "Saint-Denis", departementCode: "974" },
      { name: "Saint-Denis", departementCode: "93" },
      { name: "Saint-Denis", departementCode: "11" },
    ],
  });
});
