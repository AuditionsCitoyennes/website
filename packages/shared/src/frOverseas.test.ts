// Overseas France as one level (frOverseas.ts): which région folds into its
// département. Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { foldedDepartementOf, isOneTerritory, type TerritoryChild } from "./frOverseas";

const dep = (id: string, name: string): TerritoryChild => ({ id, name, isDepartement: true });

test("a DROM folds into the département of its name", () => {
  assert.equal(foldedDepartementOf("Guyane", [dep("fr:dep:973", "Guyane")]), "fr:dep:973");
  for (const [name, id] of [
    ["La Réunion", "fr:dep:974"],
    ["Martinique", "fr:dep:972"],
    ["Guadeloupe", "fr:dep:971"],
    ["Mayotte", "fr:dep:976"],
  ])
    assert.equal(foldedDepartementOf(name, [dep(id, name)]), id, name);
});

test("a collectivité filed as région and département under one code folds too", () => {
  assert.equal(
    foldedDepartementOf("Saint-Barthélemy", [dep("fr:dep:977", "Saint-Barthélemy")]),
    "fr:dep:977",
  );
});

test("a metropolitan région never folds", () => {
  const bretagne = [
    dep("fr:dep:22", "Côtes-d'Armor"),
    dep("fr:dep:29", "Finistère"),
    dep("fr:dep:35", "Ille-et-Vilaine"),
    dep("fr:dep:56", "Morbihan"),
  ];
  assert.equal(foldedDepartementOf("Bretagne", bretagne), null);
  // One département of another name (the seed's Île-de-France holds only Paris).
  assert.equal(foldedDepartementOf("Île-de-France", [dep("fr:dep:75", "Paris")]), null);
  assert.equal(foldedDepartementOf("Hauts-de-France", [dep("fr:dep:59", "Nord")]), null);
});

test("no child, two children, or a same-name child that is no département: not folded", () => {
  assert.equal(foldedDepartementOf("Guyane", []), null);
  assert.equal(
    foldedDepartementOf("Guyane", [dep("fr:dep:973", "Guyane"), dep("fr:dep:999", "Autre")]),
    null,
  );
  assert.equal(
    foldedDepartementOf("Guyane", [{ id: "fr:com:97302", name: "Guyane", isDepartement: false }]),
    null,
  );
});

test("names are compared exactly", () => {
  assert.equal(isOneTerritory("Guyane", null), false);
  assert.equal(isOneTerritory("Guyane", undefined), false);
  assert.equal(isOneTerritory("La Réunion", "La Reunion"), false);
  assert.equal(isOneTerritory("La Réunion", "La Réunion"), true);
});
