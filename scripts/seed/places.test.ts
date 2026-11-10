import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCATION_RULES, normalizeLocation } from "@ac/shared";
import { readFrFixtures } from "./fixtures/fr";
import { seedSql } from "./generate";
import { FRANCE_CLUSTERS, OFF_THE_MAP, ONLINE_TOWN_HALLS } from "./places";

const { lieux, online } = readFrFixtures().places;
const locations = FRANCE_CLUSTERS.flatMap((c) => c.places.map((p) => p.location));

test("every in-person lieu sits at a street or a square, but those off the map on purpose", () => {
  for (const location of locations) {
    const p = lieux[location];
    assert.ok(p, `"${location}": no fixture`);
    if (OFF_THE_MAP.includes(location)) continue;
    assert.equal(p.place_precision, "address", `"${location}"`);
    assert.ok(p.place_path, `"${location}": no place_path`);
    assert.ok(p.lat !== null && p.lng !== null, `"${location}": no point`);
  }
});

// A geocoder that now places one of them is noticed and decided, not kept
// silently.
test("the lieux off the map are edges, and unplaced", () => {
  const edges = FRANCE_CLUSTERS.find((c) => c.name === "edges")!.places.map((p) => p.location);
  for (const location of OFF_THE_MAP) {
    assert.ok(edges.includes(location), `"${location}": not an edge`);
    assert.equal(lieux[location]?.place_precision, "unplaced", `"${location}"`);
  }
});

// LOCATION_RULES claim any text holding their keywords ("bron" in "Hébron",
// "cordeliers" in another town's square): only these lieux use one.
const RULED = [
  "Marché des Gratte-Ciel, Villeurbanne",
  "Place Grandclément, Villeurbanne",
  "Marché des Charpennes, Villeurbanne",
  "Parvis de la médiathèque, Bron",
  "Marché de la Croix-Rousse, Lyon",
  "Place Jean Macé, Lyon 7",
  "Gare Part-Dieu, Lyon",
  "Place Ferber, Bron",
];

test("no lieu is claimed by a LOCATION_RULES keyword but those that use one", () => {
  for (const location of RULED) assert.ok(locations.includes(location), `"${location}": gone`);
  for (const location of locations) {
    // As getCanonicalLocation matches (a rule's canonical may be the text itself).
    const lower = normalizeLocation(location).toLowerCase();
    const claimed = LOCATION_RULES.some((r) => r.keywords.every((kw) => lower.includes(kw)));
    assert.equal(claimed, RULED.includes(location), `"${location}"`);
  }
});

test("the seed refuses a lieu without fixture", () => {
  const places = FRANCE_CLUSTERS[0].places;
  places.push({ location: "Rue Inventée, Nulle-Part", times: 1 });
  try {
    assert.throws(() => seedSql("france"), /No fixture place for "Rue Inventée, Nulle-Part"/);
  } finally {
    places.pop();
  }
});

test("every online town hall has its fixture, at its town hall or its commune", () => {
  for (const hall of ONLINE_TOWN_HALLS) {
    const p = online[hall.citycode];
    assert.ok(p, `${hall.citycode}: no fixture`);
    assert.equal(p.location, hall.location);
    assert.ok(["address", "commune"].includes(p.place_precision), hall.citycode);
  }
});
