// A lieu with one audition (lieuSingle.ts): what is known of a lieu's
// auditions from the server's row and from the corpus' groups, and the rule
// that opens the one audition with a lieu newly opened — never in the
// « Lister » mode, for the lieu already open, for a lieu of several auditions
// or of none. Plain objects stand in for the rows and
// the groups. Run with `node --import tsx --test` (root "test:scripts").
// Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { auditionToOpen, knownFromGroups, knownFromRow } from "./lieuSingle";

test("knownFromRow: the count, and the embedded list's first, else the newest (tie)", () => {
  assert.deepEqual(knownFromRow({ auditions: 1, tie: "a1" }), { count: 1, first: "a1" });
  assert.deepEqual(
    knownFromRow({ auditions: 1, tie: "a1", list: [["a1", "Marché", "2026-05-01", 4]] }),
    { count: 1, first: "a1" },
  );
  assert.deepEqual(
    knownFromRow({
      auditions: 2,
      tie: "b2",
      list: [
        ["b2", "Place", "2026-06-01", 3],
        ["b1", "Place", "2026-04-01", 5],
      ],
    }),
    { count: 2, first: "b2" },
  );
  assert.deepEqual(knownFromRow({ auditions: 0 }), { count: 0, first: null });
});

test("knownFromGroups: every audition under the lieu's name, across its groups", () => {
  const groups = [
    { canonicalName: "Place Sathonay, Lyon", auditions: [{ id: "s1" }] },
    { canonicalName: "Marché de la Croix-Rousse, Lyon", auditions: [{ id: "c1" }, { id: "c2" }] },
    { canonicalName: "Quai Saint-Vincent, Lyon", auditions: [{ id: "q1" }] },
    { canonicalName: "Quai Saint-Vincent, Lyon", auditions: [{ id: "q2" }] },
  ];
  assert.deepEqual(knownFromGroups(groups, "Place Sathonay, Lyon"), { count: 1, first: "s1" });
  assert.deepEqual(knownFromGroups(groups, "Marché de la Croix-Rousse, Lyon"), {
    count: 2,
    first: "c1",
  });
  assert.deepEqual(knownFromGroups(groups, "Quai Saint-Vincent, Lyon"), { count: 2, first: "q1" });
  assert.deepEqual(knownFromGroups(groups, "Ailleurs"), { count: 0, first: null });
});

const one = { count: 1, first: "a1" };
const opening = { mode: "ouvrir" as const, newLieu: true, known: one };

test("auditionToOpen: a lieu newly opened with one audition opens it", () => {
  assert.equal(auditionToOpen(opening), "a1");
});

test("auditionToOpen: « Lister », or the lieu already open: its list, as before", () => {
  assert.equal(auditionToOpen({ ...opening, mode: "lister" }), null);
  assert.equal(auditionToOpen({ ...opening, newLieu: false }), null);
});

test("auditionToOpen: several auditions, none, or nothing known: its list, as before", () => {
  assert.equal(auditionToOpen({ ...opening, known: { count: 2, first: "a2" } }), null);
  assert.equal(auditionToOpen({ ...opening, known: { count: 0, first: null } }), null);
  assert.equal(auditionToOpen({ ...opening, known: { count: 1, first: null } }), null);
  assert.equal(auditionToOpen({ ...opening, known: null }), null);
});
