// The geo model's unit references and France's outline gate, run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocationGroup } from "@ac/shared";
import {
  applyBoundaries,
  communeCodeOf,
  depCodeOf,
  isFrench,
  outlineSourceOf,
  type LevelLookup,
} from "./boundaries";
import { ancestorsOf, buildGeoHierarchy } from "./hierarchy";
import type { Bounds, GeoRef, GeoUnit, LevelKey, UnitGeo } from "./types";

function group(over: Partial<LocationGroup>): LocationGroup {
  return {
    canonicalName: "Lieu",
    coordinates: [45.75, 4.85],
    auditions: [],
    totalTestimonies: 1,
    city: null,
    citycode: null,
    arrondissement: null,
    departementCode: null,
    departementName: null,
    region: null,
    ...over,
  };
}

const LYON_7 = group({
  canonicalName: "Place Jean Macé, Lyon",
  coordinates: [45.745, 4.842],
  city: "Lyon",
  citycode: "69387",
  arrondissement: "Lyon 7e",
  departementCode: "69",
  departementName: "Rhône",
  region: "Auvergne-Rhône-Alpes",
});
const VILLEURBANNE = group({
  canonicalName: "Gratte-Ciel, Villeurbanne",
  coordinates: [45.768, 4.88],
  city: "Villeurbanne",
  citycode: "69266",
  departementCode: "69",
  departementName: "Rhône",
  region: "Auvergne-Rhône-Alpes",
});
const NO_DEP = group({ canonicalName: "Somewhere", region: "Occitanie" });

function unitAt(index: Map<string, GeoUnit>, levelKey: LevelKey, label: string): GeoUnit {
  const u = [...index.values()].find((x) => x.levelKey === levelKey && x.label === label);
  assert.ok(u, `${levelKey} ${label}`);
  return u;
}

test("every French unit carries its reference, height class and ancestors", () => {
  const { root, index } = buildGeoHierarchy([LYON_7, VILLEURBANNE, NO_DEP]);
  assert.equal(root.geoRef, undefined);
  assert.deepEqual(root.ancestors, []);
  assert.equal(root.heightClass, "full");

  const refOf = (levelKey: LevelKey, label: string) => unitAt(index, levelKey, label).geoRef;
  assert.deepEqual(refOf("country", "France"), {
    country: "FR",
    level: "country",
    code: "FR",
    nom: "France",
  } satisfies GeoRef);
  assert.deepEqual(refOf("region", "Auvergne-Rhône-Alpes"), {
    country: "FR",
    level: "region",
    nom: "Auvergne-Rhône-Alpes",
  });
  assert.deepEqual(refOf("dep", "Rhône"), {
    country: "FR",
    level: "county",
    code: "69",
    nom: "Rhône",
  });
  // Lyon's code is the commune's, its arrondissement's its own.
  assert.deepEqual(refOf("city", "Lyon"), {
    country: "FR",
    level: "locality",
    code: "69123",
    nom: "Lyon",
  });
  assert.deepEqual(refOf("arr", "Lyon 7e"), {
    country: "FR",
    level: "locality",
    code: "69387",
    nom: "Lyon 7e",
  });
  assert.equal(refOf("city", "Villeurbanne")?.code, "69266");
  assert.equal(refOf("place", "Place Jean Macé"), undefined);

  const heights = new Map([...index.values()].map((u) => [u.levelKey, u.heightClass]));
  assert.deepEqual(Object.fromEntries(heights), {
    world: "full",
    country: "full",
    region: "full",
    dep: "half",
    city: "half",
    arr: "half",
    place: "full",
  });

  for (const u of index.values()) {
    const chain = ancestorsOf(index, u.id).map((a) => a.id);
    assert.deepEqual([...u.ancestors, u.id], chain, u.id);
    assert.equal(u.parentId, u.ancestors.at(-1) ?? null);
  }
});

test("French units are found by France's sources", () => {
  const { index } = buildGeoHierarchy([LYON_7, VILLEURBANNE]);
  const at = (levelKey: LevelKey, label: string) => unitAt(index, levelKey, label);
  assert.deepEqual(outlineSourceOf(at("country", "France")), { kind: "metropole" });
  assert.deepEqual(outlineSourceOf(at("region", "Auvergne-Rhône-Alpes")), {
    kind: "regions",
    code: undefined,
    nom: "Auvergne-Rhône-Alpes",
  });
  assert.deepEqual(outlineSourceOf(at("dep", "Rhône")), {
    kind: "departements",
    code: "69",
    nom: "Rhône",
  });
  assert.deepEqual(outlineSourceOf(at("arr", "Lyon 7e")), { kind: "commune", insee: "69387" });
  assert.equal(outlineSourceOf(index.get("world")!), null);
  assert.equal(outlineSourceOf(at("place", "Gratte-Ciel")), null);
  assert.equal(depCodeOf(at("dep", "Rhône")), "69");
  assert.equal(communeCodeOf(at("city", "Villeurbanne")), "69266");
});

const BOX: Bounds = { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 };
function unit(
  levelKey: LevelKey,
  geoRef: GeoRef | undefined,
  over: Partial<GeoUnit> = {},
): GeoUnit {
  return {
    id: `${levelKey}:${geoRef?.country}:${geoRef?.code ?? geoRef?.nom}`,
    depth: 1,
    levelKey,
    label: geoRef?.nom ?? levelKey,
    parentId: null,
    ancestors: [],
    geoRef,
    heightClass: "full",
    count: 1,
    center: [0.5, 0.5],
    bounds: { ...BOX },
    children: [],
    ...over,
  };
}

test("a unit outside France has no outline, and knows it", () => {
  const germany = unit("country", { country: "DE", level: "country", code: "DE", nom: "France" });
  const county = unit("dep", { country: "DE", level: "county", code: "69", nom: "Rhône" });
  const region = unit("region", { country: "DE", level: "region", code: "84", nom: "Bayern" });
  const city = unit(
    "city",
    { country: "DE", level: "locality", code: "69123" },
    { insee: "69123" },
  );
  const nowhere = unit("dep", undefined);
  for (const u of [germany, county, region, city, nowhere]) {
    assert.equal(isFrench(u), false, u.id);
    assert.equal(outlineSourceOf(u), null, u.id);
    assert.equal(depCodeOf(u), undefined, u.id);
    assert.equal(communeCodeOf(u), undefined, u.id);
  }
  // France as anything but FR: no métropole either.
  assert.equal(
    outlineSourceOf(unit("country", { country: "FR", level: "country", code: "FX" })),
    null,
  );
});

function lookup(entries: [code: string, nom: string, geo: UnitGeo][]): LevelLookup {
  return {
    byCode: new Map(entries.map(([code, , geo]) => [code, geo])),
    byNom: new Map(entries.map(([, nom, geo]) => [nom, geo])),
  };
}
const geoAt = (lat: number): UnitGeo => ({
  center: [lat, lat],
  bounds: { minLat: lat - 1, maxLat: lat + 1, minLng: lat - 1, maxLng: lat + 1 },
});

test("applyBoundaries matches by code, else by name, and French units only", () => {
  const frDep = unit("dep", { country: "FR", level: "county", code: "69", nom: "Not its name" });
  const deDep = unit("dep", { country: "DE", level: "county", code: "69", nom: "Rhône" });
  const frRegion = unit("region", { country: "FR", level: "region", nom: "Bretagne" });
  const frRegionCoded = unit("region", { country: "FR", level: "region", code: "53", nom: "?" });
  const deRegion = unit("region", { country: "DE", level: "region", nom: "Bretagne" });
  const frCity = unit(
    "city",
    { country: "FR", level: "locality", code: "35238" },
    { insee: "35238" },
  );
  const deCity = unit(
    "city",
    { country: "DE", level: "locality", code: "35238" },
    { insee: "35238" },
  );
  const units = [frDep, deDep, frRegion, frRegionCoded, deRegion, frCity, deCity];
  const index = new Map(units.map((u) => [u.id, u]));
  applyBoundaries(index, {
    regions: lookup([["53", "Bretagne", geoAt(48)]]),
    departements: lookup([["69", "Rhône", geoAt(45)]]),
    byInsee: new Map([["35238", geoAt(48.1)]]),
  });
  assert.deepEqual(frDep.center, [45, 45]);
  assert.deepEqual(frRegion.center, [48, 48]);
  assert.deepEqual(frRegionCoded.center, [48, 48]);
  assert.deepEqual(frCity.center, [48.1, 48.1]);
  for (const u of [deDep, deRegion, deCity]) assert.deepEqual(u.center, [0.5, 0.5], u.id);

  // A département's own outline wins over france-geojson's.
  const own = unit("dep", { country: "FR", level: "county", code: "69", nom: "Rhône" });
  applyBoundaries(new Map([[own.id, own]]), {
    departements: lookup([["69", "Rhône", geoAt(45)]]),
    byDep: new Map([["69", geoAt(46)]]),
  });
  assert.deepEqual(own.center, [46, 46]);
});
