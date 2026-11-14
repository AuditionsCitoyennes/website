// The map's motion counters (motionCounters.ts), run with
// `node --import tsx --test` (root "test:scripts"): a mutation counts in
// motion only (the camera, a plateau, a pointer), by name, label and target;
// a planned scope takes its mutations out of the unplanned; what a mutation
// touched is read from its arguments; the plateau pipeline's runs are grouped
// by selection.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KEEP_SELECTIONS,
  MAP_MUTATORS,
  NO_LABEL,
  createMutationCounter,
  createPlateauRuns,
  mutationTarget,
} from "./motionCounters";

function setup() {
  const state = { camera: false, plateau: false, pointer: false };
  return { state, counter: createMutationCounter(() => ({ ...state })) };
}

test("the wrapped mutators are the eight the probe names", () => {
  assert.deepEqual(
    [...MAP_MUTATORS],
    [
      "setTerrain",
      "addLayer",
      "removeLayer",
      "addSource",
      "removeSource",
      "setPaintProperty",
      "setLayoutProperty",
      "setFilter",
    ],
  );
});

test("what a mutation touched is read from its arguments", () => {
  assert.equal(
    mutationTarget("setTerrain", [{ source: "plateau-dem-a", exaggeration: 0.4 }]),
    "plateau-dem-a",
  );
  assert.equal(mutationTarget("setTerrain", [null]), "null");
  assert.equal(mutationTarget("setTerrain", []), "null");
  assert.equal(
    mutationTarget("addLayer", [{ id: "plateau-prefetch", type: "hillshade" }, "x"]),
    "plateau-prefetch",
  );
  assert.equal(mutationTarget("removeLayer", ["plateau-prefetch"]), "plateau-prefetch");
  assert.equal(
    mutationTarget("addSource", ["plateau-dem-b", { type: "raster-dem" }]),
    "plateau-dem-b",
  );
  assert.equal(mutationTarget("removeSource", ["plateau-dem-b"]), "plateau-dem-b");
  assert.equal(
    mutationTarget("setPaintProperty", ["scope-mask", "fill-opacity", 0.5]),
    "scope-mask",
  );
  assert.equal(
    mutationTarget("setLayoutProperty", ["scope-mask", "visibility", "none"]),
    "scope-mask",
  );
  assert.equal(mutationTarget("setFilter", ["scope-outline", ["==", "id", "x"]]), "scope-outline");
  assert.equal(mutationTarget("addLayer", []), "?");
  assert.equal(mutationTarget("setFilter", [undefined]), "?");
});

test("a mutation on a still map counts in the total only", () => {
  const { counter } = setup();
  counter.note("setTerrain", "plateau-dem-a");
  counter.note("setData", "scope-mask");
  assert.deepEqual(counter.read(), {
    total: 2,
    inMotion: 0,
    unplanned: 0,
    byName: {},
    openScopes: 0,
  });
});

test("in motion a mutation counts by name, by what moves and by target", () => {
  const { counter, state } = setup();
  state.camera = true;
  counter.note("setTerrain", "plateau-dem-a");
  state.plateau = true;
  counter.note("setTerrain", "plateau-dem-a");
  counter.note("removeLayer", "plateau-prefetch");
  state.camera = false;
  state.plateau = false;
  state.pointer = true;
  counter.note("setData", "scope-mask");
  state.pointer = false;
  counter.note("setData", "scope-mask"); // still
  const r = counter.read();
  assert.equal(r.total, 5);
  assert.equal(r.inMotion, 4);
  assert.equal(r.unplanned, 4);
  assert.deepEqual(r.byName.setTerrain, {
    n: 2,
    unplanned: 2,
    camera: 2,
    plateau: 1,
    pointer: 0,
    labels: { [NO_LABEL]: 2 },
    unplannedLabels: { [NO_LABEL]: 2 },
    targets: { "plateau-dem-a": 2 },
  });
  assert.deepEqual(r.byName.removeLayer.targets, { "plateau-prefetch": 1 });
  assert.equal(r.byName.removeLayer.plateau, 1);
  assert.deepEqual(r.byName.setData, {
    n: 1,
    unplanned: 1,
    camera: 0,
    plateau: 0,
    pointer: 1,
    labels: { [NO_LABEL]: 1 },
    unplannedLabels: { [NO_LABEL]: 1 },
    targets: { "scope-mask": 1 },
  });
});

test("a scope labels its mutations, and a planned one takes them out of the unplanned", () => {
  const { counter, state } = setup();
  state.plateau = true;
  const endRise = counter.scope("plateau.rise", { planned: true });
  counter.note("setTerrain", "plateau-dem-a");
  counter.note("setTerrain", "plateau-dem-a");
  endRise();
  const endMask = counter.scope("mask");
  counter.note("setData", "scope-mask");
  endMask();
  counter.note("setFilter", "scope-outline");
  const r = counter.read();
  assert.equal(r.inMotion, 4);
  assert.equal(r.unplanned, 2);
  assert.deepEqual(r.byName.setTerrain.labels, { "plateau.rise": 2 });
  assert.equal(r.byName.setTerrain.unplanned, 0);
  assert.deepEqual(r.byName.setTerrain.unplannedLabels, {});
  assert.deepEqual(r.byName.setData.unplannedLabels, { mask: 1 });
  assert.deepEqual(r.byName.setFilter.unplannedLabels, { [NO_LABEL]: 1 });
  assert.equal(r.openScopes, 0);
});

test("scopes nest: the innermost label, planned if any scope around it is", () => {
  const { counter, state } = setup();
  state.camera = true;
  const endCommit = counter.scope("plateau.commit", { planned: true });
  const endSwap = counter.scope("dem.swap");
  counter.note("removeSource", "plateau-dem-a");
  assert.equal(counter.read().openScopes, 2);
  // Closed out of order: each call removes its own scope.
  endCommit();
  counter.note("addSource", "plateau-dem-b");
  endSwap();
  endSwap();
  const r = counter.read();
  assert.deepEqual(r.byName.removeSource.labels, { "dem.swap": 1 });
  assert.equal(r.byName.removeSource.unplanned, 0);
  assert.deepEqual(r.byName.addSource.unplannedLabels, { "dem.swap": 1 });
  assert.equal(r.openScopes, 0);
});

test("the reset clears the counts and what is read is a copy", () => {
  const { counter, state } = setup();
  state.camera = true;
  counter.note("setFilter", "a");
  const before = counter.read();
  counter.note("setFilter", "a");
  assert.equal(before.byName.setFilter.n, 1);
  counter.reset();
  assert.deepEqual(counter.read(), {
    total: 0,
    inMotion: 0,
    unplanned: 0,
    byName: {},
    openScopes: 0,
  });
});

test("the pipeline's runs are grouped by selection, in order", () => {
  let now = 0;
  const runs = createPlateauRuns(() => now);
  assert.deepEqual(runs.read(), { selections: 0, runs: 0, max: 0, last: null, list: [] });
  now = 100.4;
  runs.note("fr");
  now = 350;
  runs.note("fr");
  now = 900;
  runs.note("fr-84");
  now = 1200;
  runs.note("fr-84");
  now = 1300;
  runs.note("fr-84");
  now = 2000;
  runs.note("");
  now = 2500;
  runs.note("fr"); // the same unit again later is another selection
  assert.deepEqual(runs.read(), {
    selections: 4,
    runs: 7,
    max: 3,
    last: { scope: "fr", runs: 1, t0: 2500, last: 2500 },
    list: [
      { scope: "fr", runs: 2, t0: 100, last: 350 },
      { scope: "fr-84", runs: 3, t0: 900, last: 1300 },
      { scope: "", runs: 1, t0: 2000, last: 2000 },
      { scope: "fr", runs: 1, t0: 2500, last: 2500 },
    ],
  });
  runs.reset();
  assert.equal(runs.read().selections, 0);
});

test("only the last selections are kept", () => {
  const runs = createPlateauRuns(() => 0);
  for (let i = 0; i < KEEP_SELECTIONS + 5; i++) runs.note(`u${i}`);
  const r = runs.read();
  assert.equal(r.selections, KEEP_SELECTIONS);
  assert.equal(r.list[0].scope, "u5");
  assert.equal(r.last?.scope, `u${KEEP_SELECTIONS + 4}`);
});
