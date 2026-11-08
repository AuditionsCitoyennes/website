// The geo model's unit references and the outline rows' frames, run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocationGroup } from "@ac/shared";
import { applyBoundaries, communeCodeOf } from "./boundaries";
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
    // One array per family: siblings share it.
    for (const c of u.children) assert.equal(c.ancestors, u.children[0].ancestors, c.id);
  }
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

test("communeCodeOf: French villes and arrondissements only", () => {
  const { index } = buildGeoHierarchy([LYON_7, VILLEURBANNE]);
  assert.equal(communeCodeOf(unitAt(index, "city", "Villeurbanne")), "69266");
  assert.equal(communeCodeOf(unitAt(index, "arr", "Lyon 7e")), "69387");
  assert.equal(communeCodeOf(unitAt(index, "dep", "Rhône")), undefined);
  const de = unit("city", { country: "DE", level: "locality", code: "1" }, { insee: "1" });
  assert.equal(communeCodeOf(de), undefined);
});

const geoAt = (lat: number): UnitGeo => ({
  center: [lat, lat],
  bounds: { minLat: lat - 1, maxLat: lat + 1, minLng: lat - 1, maxLng: lat + 1 },
});

test("applyBoundaries: a unit matched by id takes its row's centre and box, the others keep theirs", () => {
  const dep = unit("dep", { country: "FR", level: "county", code: "69", nom: "Rhône" });
  const region = unit("region", { country: "FR", level: "region", code: "84", nom: "ARA" });
  const city = unit("city", { country: "FR", level: "locality", code: "1" }, { insee: "1" });
  const arr = unit("arr", { country: "FR", level: "locality", code: "2" }, { insee: "2" });
  const other = unit("dep", { country: "FR", level: "county", code: "01", nom: "Ain" });
  const units = [dep, region, city, arr, other];
  applyBoundaries(new Map(units.map((u) => [u.id, u])), {
    byId: new Map([dep, region, city, arr].map((u, i) => [u.id, geoAt(50 + i)])),
  });
  assert.deepEqual(
    [dep, region, city, arr].map((u) => u.center[0]),
    [50, 51, 52, 53],
  );
  assert.deepEqual(dep.bounds, geoAt(50).bounds);
  assert.deepEqual(
    { center: other.center, bounds: other.bounds },
    { center: [0.5, 0.5], bounds: BOX },
  );
});

test("applyBoundaries: a unit with no row spans its placed children (an overseas région)", () => {
  const region = unit("region", { country: "FR", level: "region", code: "03", nom: "Guyane" });
  const a = unit("city", { country: "FR", level: "locality", code: "a" }, { parentId: region.id });
  const b = unit("city", { country: "FR", level: "locality", code: "b" }, { parentId: region.id });
  region.children = [a, b];
  applyBoundaries(new Map([region, a, b].map((u) => [u.id, u])), {
    byId: new Map([
      [a.id, geoAt(4)],
      [b.id, geoAt(6)],
    ]),
  });
  assert.deepEqual(region.bounds, { minLat: 3, maxLat: 7, minLng: 3, maxLng: 7 });
  assert.deepEqual(region.center, [5, 5]);
});

test("applyBoundaries: a place keeps its exact point, France its constant frame", () => {
  const place = unit("place", undefined, { id: "l:1", center: [45.1, 4.2] });
  applyBoundaries(new Map([[place.id, place]]), { byId: new Map([[place.id, geoAt(10)]]) });
  assert.deepEqual(
    { center: place.center, bounds: place.bounds },
    { center: [45.1, 4.2], bounds: BOX },
  );

  const h = buildGeoHierarchy([LYON_7]);
  const fr = unitAt(h.index, "country", "France");
  const before = { center: [...fr.center], bounds: { ...fr.bounds } };
  applyBoundaries(h.index, { byId: new Map([[fr.id, geoAt(10)]]) });
  assert.deepEqual({ center: fr.center, bounds: fr.bounds }, before);
});

test("applyBoundaries: byId frames the other countries, not France nor a world-wide row", () => {
  const world = unit("world", undefined, { id: "world" });
  const fr = unit("country", { country: "FR", level: "country", code: "FR" }, { id: "FR" });
  const es = unit("country", { country: "ES", level: "country", code: "ES" }, { id: "ES" });
  const aq = unit("country", { country: "AQ", level: "country", code: "AQ" }, { id: "AQ" });
  world.children = [fr, es, aq];
  for (const c of world.children) c.parentId = "world";
  const frame = (minLng: number, maxLng: number): UnitGeo => ({
    center: [10, (minLng + maxLng) / 2],
    bounds: { minLat: 0, maxLat: 20, minLng, maxLng },
  });
  const index = new Map([world, fr, es, aq].map((u) => [u.id, u]));
  // France alone: nothing moves, the world keeps its box.
  const worldBefore = { center: [...world.center], bounds: { ...world.bounds } };
  applyBoundaries(index, { byId: new Map([["FR", frame(-5, 9)]]) });
  assert.deepEqual({ center: world.center, bounds: world.bounds }, worldBefore);
  assert.deepEqual(fr.bounds, BOX);

  applyBoundaries(index, {
    byId: new Map([
      ["FR", frame(-5, 9)],
      ["ES", frame(-18, 4)],
      ["AQ", frame(-180, 180)],
    ]),
  });
  assert.deepEqual(es.bounds, frame(-18, 4).bounds); // its row's box
  assert.deepEqual([fr.bounds, aq.bounds], [BOX, BOX]); // France's frame; a 360° row's none
  // The world spans its children's boxes once one is real.
  assert.deepEqual(world.bounds, { minLat: 0, maxLat: 20, minLng: -18, maxLng: 4 });
  assert.deepEqual(world.center, [10, -7]);
});
