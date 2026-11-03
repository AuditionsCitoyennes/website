// Which object a country is drawn and raised with, and which of its files
// are asked for (outlineRoles.ts), on rows shaped as build o20261101-2's.
// Run with `node --import tsx --test` (root "test:scripts"). Pure: no Vue,
// no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countryOutline,
  GLOBE_CAP,
  globeBatch,
  prefetchKind,
  rowKnownAbsent,
  selfFileOf,
  siblingSelves,
  SIBLING_SELF_CAP,
  type RoleRow,
} from "./outlineRoles";
import type { Bounds } from "./types";

const box = (minLng: number, minLat: number, maxLng: number, maxLat: number): Bounds => ({
  minLat,
  maxLat,
  minLng,
  maxLng,
});
// The rows of o20261101-2 (root.json), trimmed to what the rules read.
const ROWS: Record<string, RoleRow> = {
  FR: { st: "fr1000", k: 1, u: 0, g: 1, bounds: box(-5.1412, 41.33385, 9.55997, 51.08915) },
  ES: { st: "c300", k: 0, u: 1, g: 1, bounds: box(-18.15676, 27.63774, 4.32803, 43.79035) },
  DE: { st: "c100", k: 0, u: 1, g: 1, bounds: box(5.86632, 47.27025, 15.04193, 55.05854) },
  MC: { st: "c15", k: 0, u: 1, g: 1, bounds: box(7.40903, 43.72641, 7.441, 43.75192) },
  CA: { st: "c3000", k: 0, u: 1, g: 1, bounds: box(-141.00275, 41.67693, -52.6194, 83.11506) },
  AQ: { st: "c3000", k: 0, u: 1, g: 1, wrap: true, bounds: box(-180, -85.0511, 180, -60.5095) },
  RU: {
    st: "c3000",
    k: 0,
    u: 1,
    g: 1,
    wrap: true,
    bounds: box(19.6387, 41.1851, 190.99232, 81.85905),
  },
};
const rowOf = (id: string) => ROWS[id];
/** A store holding, per id, a self and a world object. */
const objects = (selves: string[], globes: string[]) => ({
  selfOf: (id: string) => (selves.includes(id) ? `u/${id}` : undefined),
  globeOf: (id: string) => (globes.includes(id) ? `g/${id}` : undefined),
});
const all = Object.keys(ROWS);

test("France is its k/ self in every role, never its g/", () => {
  assert.equal(selfFileOf(ROWS.FR), "k");
  const v = objects(["FR"], ["FR"]);
  assert.equal(countryOutline(v, "FR", ROWS.FR, false), "u/FR");
  assert.equal(countryOutline(v, "FR", ROWS.FR, true), "u/FR");
  assert.equal(countryOutline(objects([], ["FR"]), "FR", ROWS.FR, false), undefined);
  assert.equal(prefetchKind(ROWS.FR), "k");
  const countries = all.map((id) => ({ id, bounds: ROWS[id].bounds! }));
  const batch = globeBatch(countries, rowOf);
  assert.ok(!batch.g.includes("FR") && !batch.u.includes("FR"));
});

test("a country is drawn with its g/ and raised with its u/, each standing in for the other", () => {
  assert.equal(selfFileOf(ROWS.ES), "u");
  assert.equal(prefetchKind(ROWS.ES), "u");
  const both = objects(["ES"], ["ES"]);
  assert.equal(countryOutline(both, "ES", ROWS.ES, false), "g/ES");
  assert.equal(countryOutline(both, "ES", ROWS.ES, true), "u/ES");
  assert.equal(countryOutline(objects([], ["ES"]), "ES", ROWS.ES, true), "g/ES");
  assert.equal(countryOutline(objects(["ES"], []), "ES", ROWS.ES, false), "u/ES");
  assert.equal(countryOutline(objects([], []), "ES", ROWS.ES, true), undefined);
});

test("a c3000 row is served by its g/: no u/, nothing to hold or prefetch", () => {
  assert.equal(selfFileOf(ROWS.CA), "g");
  assert.equal(prefetchKind(ROWS.CA), null);
  const v = objects(["CA"], ["CA"]);
  assert.equal(countryOutline(v, "CA", ROWS.CA, true), "g/CA");
  assert.equal(countryOutline(v, "CA", ROWS.CA, false), "g/CA");
  assert.equal(
    siblingSelves(
      { id: "US", bounds: ROWS.CA.bounds! },
      [{ id: "CA", bounds: ROWS.CA.bounds! }],
      rowOf,
    ).length,
    0,
  );
});

test("a micro-state takes its u/ in every role, in the globe batch", () => {
  const v = objects(["MC"], ["MC"]);
  assert.equal(countryOutline(v, "MC", ROWS.MC, false), "u/MC");
  assert.equal(countryOutline(v, "MC", ROWS.MC, true), "u/MC");
  const batch = globeBatch([{ id: "MC", bounds: ROWS.MC.bounds! }], rowOf);
  assert.deepEqual(batch, { g: [], u: ["MC"] });
});

test("known absent: no row, a world-wide row, a wrapped row (this wave)", () => {
  for (const row of [undefined, ROWS.AQ, ROWS.RU]) {
    assert.equal(rowKnownAbsent(row), true);
    assert.equal(selfFileOf(row), null);
    assert.equal(prefetchKind(row), null);
  }
  assert.equal(rowKnownAbsent({ ...ROWS.AQ, wrap: false }), true); // 360° on its own
  assert.equal(countryOutline(objects(["RU"], ["RU"]), "RU", ROWS.RU, true), undefined);
  const countries = ["AQ", "RU", "QQ"].map((id) => ({ id, bounds: box(0, 0, 1, 1) }));
  assert.deepEqual(globeBatch(countries, rowOf), { g: [], u: [] });
  assert.equal(rowKnownAbsent(ROWS.ES), false);
});

test("globe batch: the first GLOBE_CAP in the tree's order, then those meeting the view", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `C${String(i).padStart(2, "0")}`,
    bounds: box(i, 0, i + 0.5, 1),
  }));
  const row: RoleRow = { st: "c100", k: 0, u: 1, g: 1, bounds: box(0, 0, 5, 5) };
  const batch = globeBatch(many, () => row);
  assert.equal(GLOBE_CAP, 40);
  assert.deepEqual(
    batch.g,
    many.slice(0, 40).map((c) => c.id),
  ); // the tree's order kept
  assert.deepEqual(
    globeBatch(many, () => row),
    batch,
  ); // deterministic
  // Beyond the cap, only those whose box meets the view (padded 15 %).
  const view = box(49.2, 0, 50.8, 1); // padded: 48.96 … 51.04
  assert.deepEqual(globeBatch(many, () => row, view).g.slice(40), ["C49", "C50", "C51"]);
  // A row without g/ is left out (and does not count toward the cap).
  const noG = globeBatch(many, (id) => (id === "C00" ? { ...row, g: 0 } : row));
  assert.equal(noG.g[0], "C01");
  assert.equal(noG.g.length, 40);
});

test("sibling selves: the box-meeting neighbours with a u/, in the tree's order, capped", () => {
  const scope = { id: "DE", bounds: ROWS.DE.bounds! };
  const row: RoleRow = { st: "c100", k: 0, u: 1, g: 1 };
  const around = Array.from({ length: 12 }, (_, i) => ({
    id: `N${i}`,
    bounds: box(10, 50, 11, 51),
  }));
  const far = { id: "JP", bounds: box(122, 24, 154, 45) };
  const ids = siblingSelves(scope, [far, scope, ...around], (id) => (id === "DE" ? ROWS.DE : row));
  assert.equal(SIBLING_SELF_CAP, 8);
  assert.deepEqual(
    ids,
    around.slice(0, 8).map((s) => s.id),
  );
  // France (k/) and Canada (g/) never: their selves are not u/ files.
  const fr = { id: "FR", bounds: ROWS.FR.bounds! };
  assert.deepEqual(siblingSelves(scope, [fr], rowOf), []);
});
