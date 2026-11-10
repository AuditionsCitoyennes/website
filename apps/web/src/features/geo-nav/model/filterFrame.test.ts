// What the map frames while filters are on (filterFrame.ts). Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GeoUnit, LevelKey } from "@/features/geo";
import { filterFrameUnit, stillFramed } from "./filterFrame";

function unit(id: string, levelKey: LevelKey, parent: GeoUnit | null): GeoUnit {
  const u: GeoUnit = {
    id,
    depth: parent ? parent.depth + 1 : 0,
    levelKey,
    label: id,
    parentId: parent?.id ?? null,
    ancestors: parent ? [...parent.ancestors, parent.id] : [],
    heightClass: "full",
    count: 1,
    center: [0, 0],
    bounds: { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 },
    children: [],
  };
  parent?.children.push(u);
  return u;
}

// The world → France → Auvergne-Rhône-Alpes → Rhône → Lyon → Lyon 7e → a lieu,
// and Belgium → Brussels beside France.
const world = unit("world", "world", null);
const fr = unit("FR", "country", world);
const ara = unit("ARA", "region", fr);
const rhone = unit("69", "dep", ara);
const lyon = unit("lyon", "city", rhone);
const lyon7 = unit("lyon-7", "arr", lyon);
const lieu = unit("lieu", "place", lyon7);
const be = unit("BE", "country", world);
const bxl = unit("bxl", "region", be);
const index = new Map(
  [world, fr, ara, rhone, lyon, lyon7, lieu, be, bxl].map((u) => [u.id, u] as const),
);

test("at Rhône the country framed is France", () => {
  assert.equal(filterFrameUnit(rhone, index, true), fr);
});

test("at France, France itself", () => {
  assert.equal(filterFrameUnit(fr, index, true), fr);
});

test("at the world, nothing", () => {
  assert.equal(filterFrameUnit(world, index, true), null);
});

test("at a lieu inside Lyon, France", () => {
  assert.equal(filterFrameUnit(lieu, index, true), fr);
});

test("a country the index does not hold: nothing", () => {
  const orphan: GeoUnit = { ...rhone, id: "13", ancestors: ["world", "XX", "PAC"] };
  assert.equal(filterFrameUnit(orphan, index, true), null);
});

test("filters off: nothing", () => {
  assert.equal(filterFrameUnit(rhone, index, false), null);
});

test("at a Belgian unit, Belgium — not the world's first country", () => {
  assert.equal(filterFrameUnit(bxl, index, true), be);
});

test("stillFramed: the same unit, key and no hand", () => {
  const framed = { key: 7, unitId: "FR" };
  assert.equal(stillFramed("FR", framed, 7, false), true);
  assert.equal(stillFramed("BE", framed, 7, false), false); // another unit
  assert.equal(stillFramed("FR", framed, 8, false), false); // a command since
  assert.equal(stillFramed("FR", framed, 7, true), false); // moved by hand
  assert.equal(stillFramed("FR", null, 7, false), false); // nothing framed yet
});
