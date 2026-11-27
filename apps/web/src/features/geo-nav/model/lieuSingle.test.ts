// The audition a lieu opens with (lieuSingle.ts): what is known of a lieu's
// auditions from the server's row — how many, the newest — and the rule that
// opens one with a lieu newly opened: its one audition whichever way it is
// opened; its list for several, whichever way too, and for the lieu already
// open. Plain objects stand in for the rows. Run with `node --import tsx
// --test` (root "test:scripts").
// Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditionToOpen,
  foldsToList,
  knownFromRow,
  waitsForText,
  type LieuAuditionsKnown,
} from "./lieuSingle";

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

const one: LieuAuditionsKnown = { count: 1, first: "a1" };
const many: LieuAuditionsKnown = { count: 3, first: "n3" };

test("auditionToOpen: a lieu newly opened with one audition opens it", () => {
  assert.equal(auditionToOpen({ newLieu: true, known: one }), "a1");
});

test("auditionToOpen: several: its list, nothing opened", () => {
  assert.equal(auditionToOpen({ newLieu: true, known: many }), null);
  assert.equal(auditionToOpen({ newLieu: true, known: { count: 2, first: "b2" } }), null);
  assert.equal(auditionToOpen({ newLieu: true, known: { count: 3, first: null } }), null);
});

test("auditionToOpen: the lieu already open: as it is (only the map comes back)", () => {
  for (const known of [one, many]) {
    assert.equal(auditionToOpen({ newLieu: false, known }), null);
  }
});

test("auditionToOpen: none, or nothing known: its list, as before", () => {
  assert.equal(auditionToOpen({ newLieu: true, known: { count: 0, first: null } }), null);
  assert.equal(auditionToOpen({ newLieu: true, known: { count: 1, first: null } }), null);
  assert.equal(auditionToOpen({ newLieu: true, known: null }), null);
});

/** #218's rule. */
const before = (o: { newLieu: boolean; known: LieuAuditionsKnown | null }) =>
  !o.newLieu || !o.known ? null : o.known.count === 1 ? o.known.first : null;

test("auditionToOpen: exactly #218's rule, every case", () => {
  const knowns: (LieuAuditionsKnown | null)[] = [
    null,
    { count: 0, first: null },
    one,
    { count: 1, first: null },
    many,
    { count: 2, first: null },
    { count: 12, first: "z" },
  ];
  for (const newLieu of [true, false]) {
    for (const known of knowns) {
      const o = { newLieu, known };
      assert.equal(auditionToOpen(o), before(o));
    }
  }
});

test("waitsForText: its one audition opened from its pin or its row waits", () => {
  assert.equal(waitsForText({ only: "a1", via: "map" }), true);
  assert.equal(waitsForText({ only: "a1", via: "panel" }), true);
});

test("waitsForText: its crumb, or no audition opened with the lieu: no wait", () => {
  assert.equal(waitsForText({ only: "a1", via: "crumb" }), false);
  for (const via of ["map", "panel", "crumb"] as const) {
    assert.equal(waitsForText({ only: null, via }), false);
  }
});

test("foldsToList: a lieu of several with one of them open", () => {
  const base = { lieuOpen: true, auditionOpen: true };
  assert.equal(foldsToList({ ...base, count: 2 }), true);
  assert.equal(foldsToList({ ...base, count: 12 }), true);
});

test("foldsToList: otherwise as before (crumb re-aims, arrow goes up)", () => {
  const base = { lieuOpen: true, auditionOpen: true, count: 3 };
  assert.equal(foldsToList({ ...base, lieuOpen: false }), false);
  assert.equal(foldsToList({ ...base, auditionOpen: false }), false);
  // A lieu of one: its list of one line is the step lieuSingle leaves out.
  assert.equal(foldsToList({ ...base, count: 1 }), false);
  assert.equal(foldsToList({ ...base, count: 0 }), false);
});
