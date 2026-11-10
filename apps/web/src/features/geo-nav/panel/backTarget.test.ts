// The panel's back arrow target (backTarget.ts): the crumb before the last, so
// the scope's parent, or the lieu's own unit when a lieu ends the trail; none
// at the root. Plain objects stand in for GeoUnits. Run with `node --import
// tsx --test` (root "test:scripts"). Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { backTarget } from "./backTarget";

type U = { id: string; label: string; levelKey: string };
const unit = (id: string, label: string, levelKey: string): U => ({ id, label, levelKey });
const monde = unit("monde", "Monde", "world");
const france = unit("fr", "France", "country");
const ara = unit("fr-84", "Auvergne-Rhône-Alpes", "region");
const rhone = unit("fr-69", "Rhône", "departement");
const lyon = unit("fr-69123", "Lyon", "commune");
const lyon7 = unit("fr-69387", "Lyon 7e", "arrondissement");
const lieu = unit("place-1", "Place Jean Macé", "place");

test("backTarget: none for an empty trail or the root alone", () => {
  assert.equal(backTarget([]), null);
  assert.equal(backTarget([monde]), null);
});

test("backTarget: the crumb before the last, the same object", () => {
  assert.equal(backTarget([monde, france]), monde);
  assert.equal(backTarget([monde, france, ara, rhone, lyon]), rhone);
});

test("backTarget: with a lieu ending the trail, the lieu's own unit", () => {
  assert.equal(backTarget([monde, france, ara, rhone, lyon, lyon7, lieu]), lyon7);
});

test("backTarget: four presses from Lyon walk up to Monde, then none", () => {
  let trail: readonly U[] = [monde, france, ara, rhone, lyon];
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const t = backTarget(trail);
    assert.ok(t);
    seen.push(t.label);
    trail = trail.slice(0, trail.indexOf(t) + 1);
  }
  assert.deepEqual(seen, ["Rhône", "Auvergne-Rhône-Alpes", "France", "Monde"]);
  assert.equal(backTarget(trail), null);
});

test("backTarget: does not mutate the trail", () => {
  const trail = Object.freeze([monde, france, ara]);
  assert.equal(backTarget(trail), france);
  assert.deepEqual(trail, [monde, france, ara]);
});
