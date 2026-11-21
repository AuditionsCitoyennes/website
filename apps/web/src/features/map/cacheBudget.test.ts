// The map's cache sizes (cacheBudget.ts), run with `node --import tsx --test`
// (root "test:scripts"): the sizes each device tier gets; the large ones tied
// to the constants of the modules they bound; the Mapbox option of a tile
// budget.

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
g.localStorage = { getItem: () => null, setItem: () => {} };
g.window = { location: { reload: () => {} } };

let n = 0;
async function load(testTools: boolean) {
  g.__TEST_TOOLS__ = testTools;
  return (await import(`./cacheBudget.ts?load=${++n}`)) as typeof import("./cacheBudget");
}

test("cacheBudgetFor: the large sizes on the full tier, the small ones on a weak device", async () => {
  const { cacheBudgetFor, LARGE_CACHES, SMALL_CACHES } = await load(false);
  assert.equal(cacheBudgetFor("full"), LARGE_CACHES);
  assert.equal(cacheBudgetFor("light"), SMALL_CACHES);
  assert.equal(cacheBudgetFor("minimal"), SMALL_CACHES);
});

test("cacheBudgetNow: under node (no hint, no renderer) the full tier's", async () => {
  const m = await load(true);
  assert.equal(m.cacheBudgetNow(), m.LARGE_CACHES);
  assert.equal(m.cacheBudgetAtCreation(), m.LARGE_CACHES);
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
