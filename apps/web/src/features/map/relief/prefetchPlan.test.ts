// The spare slot's plan (prefetchPlan.ts) over its whole truth table, run with
// `node --import tsx --test` (root "test:scripts"). Pure: no map, no Vue.

import assert from "node:assert/strict";
import { test } from "node:test";
import { planPrefetch, type PrefetchInputs } from "./prefetchPlan";
import type { ReliefPrefetch } from "./reliefSwitch";

const T = "ac-dem://k1/{z}/{x}/{y}";
const OTHER = "ac-dem://k0/{z}/{x}/{y}";
const Z = 9;

const PREFETCHES: ReliefPrefetch[] = ["hillshade", "terrain0"];
const BOOLS = [false, true];

/** Every input: the modes, the run's state and the spare slot's. */
function* inputs(): Generator<PrefetchInputs> {
  for (const prefetch of PREFETCHES)
    for (const standing of BOOLS)
      for (const quietWanted of BOOLS)
        for (const nextIsTerrain of BOOLS)
          for (const nextExists of BOOLS)
            for (const nextTemplate of [undefined, T, OTHER])
              for (const nextMaxzoom of [undefined, Z, Z + 2]) {
                // quiet implies a plateau standing (`!changed && plateauVersion && terrain`).
                if (quietWanted && !standing) continue;
                yield {
                  prefetch,
                  standing,
                  quiet: quietWanted,
                  nextIsTerrain,
                  nextExists,
                  nextTemplate,
                  nextMaxzoom,
                  template: T,
                  zCanon: Z,
                };
              }
}

test("hillshade: today's actions wherever the spare slot is not the terrain", () => {
  for (const i of inputs()) {
    if (i.prefetch !== "hillshade" || i.nextIsTerrain) continue;
    assert.deepEqual(
      planPrefetch(i),
      { slot: "add", setMaxzoom: false, hillshade: true, earlyTerrain: false },
      JSON.stringify(i),
    );
  }
});

test("terrain0: the quiet swap keeps the hillshade", () => {
  for (const i of inputs()) {
    if (i.prefetch !== "terrain0" || !i.quiet) continue;
    const p = planPrefetch(i);
    assert.equal(p.hillshade, true, JSON.stringify(i));
    assert.equal(p.earlyTerrain, false, JSON.stringify(i));
  }
});

test("terrain0, nothing standing: no hillshade, the early terrain", () => {
  for (const i of inputs()) {
    if (i.prefetch !== "terrain0" || i.standing) continue;
    const p = planPrefetch(i);
    assert.equal(p.hillshade, false, JSON.stringify(i));
    // The slot already the terrain (at 0): no second set.
    assert.equal(p.earlyTerrain, !i.nextIsTerrain, JSON.stringify(i));
  }
});

test("terrain0, a plateau standing, not quiet: no hillshade, no early terrain", () => {
  for (const i of inputs()) {
    if (i.prefetch !== "terrain0" || !i.standing || i.quiet) continue;
    const p = planPrefetch(i);
    assert.equal(p.hillshade, false, JSON.stringify(i));
    assert.equal(p.earlyTerrain, false, JSON.stringify(i));
  }
});

test("the spare slot is the terrain: never added, in every mode", () => {
  let n = 0;
  for (const i of inputs()) {
    if (!i.nextIsTerrain || !i.nextExists) continue;
    n++;
    const p = planPrefetch(i);
    const sameZoom = i.nextMaxzoom === Z;
    assert.notEqual(p.slot, "add", JSON.stringify(i));
    assert.equal(p.setMaxzoom, !sameZoom, JSON.stringify(i));
    assert.equal(p.slot, i.nextTemplate === T && sameZoom ? "keep" : "repoint", JSON.stringify(i));
    assert.equal(p.earlyTerrain, false, JSON.stringify(i));
  }
  assert.ok(n > 0);
});

test("a terrain id with no source behind it: added (nothing to remove)", () => {
  for (const i of inputs()) {
    if (!i.nextIsTerrain || i.nextExists) continue;
    assert.equal(planPrefetch(i).slot, "add", JSON.stringify(i));
  }
});

test("the named cases", () => {
  const base: PrefetchInputs = {
    prefetch: "terrain0",
    standing: true,
    quiet: false,
    nextIsTerrain: true,
    nextExists: true,
    nextTemplate: T,
    nextMaxzoom: Z,
    template: T,
    zCanon: Z,
  };
  // Monde → France twice (same key): kept.
  assert.equal(planPrefetch(base).slot, "keep");
  // France → ARA (another key): re-pointed, the maxzoom with it.
  assert.deepEqual(planPrefetch({ ...base, template: OTHER, zCanon: Z + 1 }), {
    slot: "repoint",
    setMaxzoom: true,
    hillshade: false,
    earlyTerrain: false,
  });
});
