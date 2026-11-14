// The ac:map-caches switch and its sizes (cacheBudget.ts) against a stubbed
// localStorage, run with `node --import tsx --test` (root "test:scripts"):
// the kept value, garbage and a throwing storage; the page's value with and
// without the testing tools; a choice kept with a reload; the sizes each
// choice gives each device tier; "large" tied to the constants of the modules
// it bounds; the Mapbox option of a tile budget.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MESH_TOKEN_CAP_VERTICES } from "./gl/meshClientCore";
import { MAX_RECORDS } from "./relief/demAnswer";
import { MAX_STORED_VERTICES, MAX_VERSIONS } from "./relief/demWorkerCore";

const g = globalThis as unknown as {
  __TEST_TOOLS__: boolean;
  localStorage?: unknown;
  window?: unknown;
};
let stored: Record<string, string> = {};
let throwing = false;
let reloads = 0;
g.localStorage = {
  getItem(k: string) {
    if (throwing) throw new Error("blocked");
    return stored[k] ?? null;
  },
  setItem(k: string, v: string) {
    if (throwing) throw new Error("blocked");
    stored[k] = v;
  },
};
g.window = { location: { reload: () => reloads++ } };

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./cacheBudget.ts?load=${++n}`)) as typeof import("./cacheBudget");
}

test("storedMapCaches: the kept value, else the default", async () => {
  const m = await load(false);
  assert.equal(m.DEFAULT_MAP_CACHES, "auto");
  assert.deepEqual([...m.MAP_CACHES], ["auto", "large", "small"]);
  for (const kept of m.MAP_CACHES) {
    stored = { "ac:map-caches": kept };
    assert.equal(m.storedMapCaches(), kept);
  }
  for (const garbage of ["", "Small", "petit", "full", " large", "0"]) {
    stored = { "ac:map-caches": garbage };
    assert.equal(m.storedMapCaches(), "auto", garbage);
  }
  stored = {};
  assert.equal(m.storedMapCaches(), "auto");
  throwing = true;
  assert.equal(m.storedMapCaches(), "auto");
  throwing = false;
});

test("mapCaches: the kept value with the testing tools, the default without", async () => {
  stored = { "ac:map-caches": "small" };
  assert.equal((await load(true)).mapCaches, "small");
  assert.equal((await load(false)).mapCaches, "auto");
  stored = {};
  assert.equal((await load(true)).mapCaches, "auto");
});

test("setMapCaches: kept and the page loaded again; nothing for the same choice or without the tools", async () => {
  stored = {};
  reloads = 0;
  const m = await load(true);
  m.setMapCaches("auto");
  assert.equal(reloads, 0);
  m.setMapCaches("large");
  assert.equal(stored["ac:map-caches"], "large");
  assert.equal(reloads, 1);
  throwing = true;
  m.setMapCaches("small");
  throwing = false;
  assert.equal(reloads, 2);
  assert.equal(stored["ac:map-caches"], "large");
  stored = {};
  reloads = 0;
  (await load(false)).setMapCaches("small");
  assert.equal(reloads, 0);
  assert.deepEqual(stored, {});
});

test("cacheBudgetFor: auto follows the tier, a forced choice does not", async () => {
  const { cacheBudgetFor, LARGE_CACHES, SMALL_CACHES } = await load(false);
  assert.equal(cacheBudgetFor("auto", "full"), LARGE_CACHES);
  assert.equal(cacheBudgetFor("auto", "light"), SMALL_CACHES);
  assert.equal(cacheBudgetFor("auto", "minimal"), SMALL_CACHES);
  for (const tier of ["full", "light", "minimal"] as const) {
    assert.equal(cacheBudgetFor("large", tier), LARGE_CACHES);
    assert.equal(cacheBudgetFor("small", tier), SMALL_CACHES);
  }
});

test("cacheBudgetNow: this page load's choice; under node (no hint, no renderer) the full tier's", async () => {
  stored = { "ac:map-caches": "small" };
  const forced = await load(true);
  assert.equal(forced.cacheBudgetNow(), forced.SMALL_CACHES);
  assert.equal(forced.cacheBudgetAtCreation(), forced.SMALL_CACHES);
  stored = {};
  const auto = await load(true);
  assert.equal(auto.cacheBudgetNow(), auto.LARGE_CACHES);
});

test("large: the sizes of the modules it bounds, and Mapbox's own tile sizing", async () => {
  const { LARGE_CACHES } = await load(false);
  assert.equal(LARGE_CACHES.mapTiles, null);
  assert.equal(LARGE_CACHES.lidTiles, null);
  assert.equal(LARGE_CACHES.meshVertices, MESH_TOKEN_CAP_VERTICES);
  assert.equal(LARGE_CACHES.reliefVersions, MAX_VERSIONS);
  assert.equal(LARGE_CACHES.reliefVertices, MAX_STORED_VERTICES);
  assert.equal(LARGE_CACHES.reliefRecords, MAX_RECORDS);
  // The tile answers' own size is the class's default argument.
  const tiles = readFileSync(new URL("./relief/demTiles.ts", import.meta.url), "utf8");
  const own = /constructor\(private readonly max: number \| \(\(\) => number\) = (\d+)\)/.exec(
    tiles,
  );
  assert.equal(LARGE_CACHES.reliefTiles, Number(own?.[1]));
});

test("small: every size under large's, none at zero", async () => {
  const { LARGE_CACHES, SMALL_CACHES } = await load(false);
  for (const k of [
    "meshVertices",
    "reliefVersions",
    "reliefVertices",
    "reliefRecords",
    "reliefTiles",
  ] as const) {
    assert.ok(SMALL_CACHES[k] > 0, k);
    assert.ok(SMALL_CACHES[k] < LARGE_CACHES[k], k);
  }
  // Tiles: a number where large leaves Mapbox its own sizing (30 a source on
  // a 360 × 740 phone), the hidden map's under the visible one's.
  assert.ok(SMALL_CACHES.mapTiles !== null && SMALL_CACHES.mapTiles > 0);
  assert.ok(SMALL_CACHES.mapTiles! < 30);
  assert.ok(SMALL_CACHES.lidTiles !== null && SMALL_CACHES.lidTiles > 0);
  assert.ok(SMALL_CACHES.lidTiles! <= SMALL_CACHES.mapTiles!);
});

test("tileCacheOption: no option for Mapbox's own sizing, the number otherwise", async () => {
  const { tileCacheOption } = await load(false);
  assert.deepEqual(tileCacheOption(null), {});
  assert.deepEqual(tileCacheOption(12), { maxTileCacheSize: 12 });
});
