// Which reads of the map page wait (bootReadsSwitch.ts), run with
// `node --import tsx --test` (root "test:scripts"): when the Filtres dialog's
// data is wanted in each mode, how many testimony pages are asked ahead on
// each link, and the switches read only with the testing tools (garbage and
// blocked storage read as the defaults).

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };
g.__TEST_TOOLS__ = false;
const sw = await import("./bootReadsSwitch");
const { filtersDataWanted, linkSpared, prefetchCount } = sw;

test("the defaults: « repos » and « auto », and a build without the testing tools reads no storage", () => {
  assert.equal(sw.DEFAULT_FILTERS_LOAD, "repos");
  assert.equal(sw.DEFAULT_PREFETCH, "auto");
  assert.deepEqual(sw.FILTERS_LOADS, ["repos", "ouverture", "demarrage"]);
  assert.deepEqual(sw.PREFETCHES, ["auto", "trois", "un"]);
  assert.equal(sw.filtersLoad, "repos");
  assert.equal(sw.prefetch, "auto");
  assert.equal(sw.FILTERS_IDLE_MS, 3000);
});

test("the dialog's data: at its opening in every mode; else after the idle wait, at once, or never", () => {
  const s = (opened: boolean, idle: boolean, treeShown: boolean) => ({ opened, idle, treeShown });
  for (const mode of sw.FILTERS_LOADS)
    assert.equal(filtersDataWanted(mode, s(true, false, false)), true, mode);
  // "demarrage": as before, once the page's own tree is on screen.
  assert.equal(filtersDataWanted("demarrage", s(false, false, false)), false);
  assert.equal(filtersDataWanted("demarrage", s(false, false, true)), true);
  // "repos": the tree on screen AND the idle moment passed.
  assert.equal(filtersDataWanted("repos", s(false, false, true)), false);
  assert.equal(filtersDataWanted("repos", s(false, true, false)), false);
  assert.equal(filtersDataWanted("repos", s(false, true, true)), true);
  // "ouverture": the opening alone.
  assert.equal(filtersDataWanted("ouverture", s(false, true, true)), false);
});

test("pages asked ahead: three, one on a spared link under « auto »; the forced modes ignore the link", () => {
  assert.equal(prefetchCount("auto", undefined), 3, "no connection API (Safari, Firefox)");
  assert.equal(prefetchCount("auto", { effectiveType: "4g" }), 3);
  assert.equal(prefetchCount("auto", { effectiveType: "3g" }), 1);
  assert.equal(prefetchCount("auto", { effectiveType: "2g" }), 1);
  assert.equal(prefetchCount("auto", { effectiveType: "slow-2g" }), 1);
  assert.equal(prefetchCount("auto", { saveData: true, effectiveType: "4g" }), 1);
  assert.equal(prefetchCount("trois", { saveData: true }), 3);
  assert.equal(prefetchCount("un", { effectiveType: "4g" }), 1);
  assert.equal(linkSpared(null), false);
  assert.equal(linkSpared({ saveData: false }), false);
});

test("the stored modes are read back, garbage and blocked storage as the defaults", () => {
  const kept = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => kept.get(k) ?? null };
  kept.set("ac:filters-load", "ouverture");
  kept.set("ac:prefetch", "un");
  assert.equal(sw.storedFiltersLoad(), "ouverture");
  assert.equal(sw.storedPrefetch(), "un");
  kept.set("ac:filters-load", "x");
  kept.set("ac:prefetch", "");
  assert.equal(sw.storedFiltersLoad(), "repos");
  assert.equal(sw.storedPrefetch(), "auto");
  g.localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(sw.storedFiltersLoad(), "repos");
  assert.equal(sw.storedPrefetch(), "auto");
  delete g.localStorage;
});
