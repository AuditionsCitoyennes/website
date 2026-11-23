// The audition a lieu opens with (lieuSingle.ts): what is known of a lieu's
// auditions from the server's row — how many, the newest, the top of its list
// in the panel's order — and the rule that opens one with a lieu newly
// opened: its one audition whichever way it is opened; for several, the top
// of its list from its pin on the map under "premiere" (or the wait for its
// list when none is embedded); its list otherwise, and for the lieu already
// open. Plain objects stand in for the rows. Run with
// `node --import tsx --test` (root "test:scripts").
// Pure: no Vue, no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";
import { lieuListOrder } from "./auditions";
import { AWAIT_LIST, auditionToOpen, knownFromRow, type LieuAuditionsKnown } from "./lieuSingle";
import { DEFAULT_PIN_OPEN, PIN_OPEN_MODES } from "./pinOpen";

test("knownFromRow: the count, and the embedded list's first, else the newest (tie)", () => {
  assert.deepEqual(knownFromRow({ auditions: 1, tie: "a1" }), {
    count: 1,
    first: "a1",
    top: null,
  });
  assert.deepEqual(
    knownFromRow({ auditions: 1, tie: "a1", list: [["a1", "Marché", "2026-05-01", 4]] }),
    { count: 1, first: "a1", top: "a1" },
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
    { count: 2, first: "b2", top: "b2" },
  );
  assert.deepEqual(knownFromRow({ auditions: 0 }), { count: 0, first: null, top: null });
});

/** As the server embeds a lieu's list: newest first, then id. */
const LIST: [string, string, string | null, number][] = [
  ["d", "D", "2026-10-01", 2],
  ["b", "B", "2026-09-01", 1],
  ["c", "C", "2026-09-01", 5],
  ["a", "A", "2026-05-01", 3],
  ["u", "U", null, 1],
];
const row = { auditions: LIST.length, tie: "d", list: LIST };

test("knownFromRow: the top is the panel's first line, either sort", () => {
  assert.equal(knownFromRow(row).top, "d");
  assert.equal(knownFromRow(row, "recent").top, "d");
  // Oldest first: the oldest dated one, never the newest (`first`), nor the undated.
  assert.equal(knownFromRow(row, "ancien").top, "a");
  assert.equal(knownFromRow(row, "ancien").first, "d");
  // The panel's list from the same rows (usePanelAuditions' placeAuditions).
  for (const sort of [undefined, "recent", "ancien"] as const) {
    const panel = lieuListOrder(
      LIST.map(([id, title, date, n]) => ({ id, title, date, n })),
      sort,
    );
    assert.equal(knownFromRow(row, sort).top, panel[0].id, String(sort));
  }
});

test("knownFromRow: equal dates keep the server's order; undated ones go last", () => {
  const ties: [string, string, string | null, number][] = [
    ["x2", "X", "2026-09-01", 1],
    ["x1", "X", "2026-09-01", 1],
  ];
  assert.equal(knownFromRow({ auditions: 2, tie: "x2", list: ties }, "recent").top, "x2");
  assert.equal(knownFromRow({ auditions: 2, tie: "x2", list: ties }, "ancien").top, "x2");
  const undated: [string, string, string | null, number][] = [
    ["n", "N", null, 1],
    ["m", "M", "2026-01-01", 1],
  ];
  for (const sort of ["recent", "ancien"] as const) {
    assert.equal(knownFromRow({ auditions: 2, tie: "m", list: undated }, sort).top, "m", sort);
  }
  // Not embedded (the server's lazy path): no top.
  assert.equal(knownFromRow({ auditions: 3, tie: "d" }, "ancien").top, null);
});

test("the switch: two modes, the first audition by default", () => {
  assert.deepEqual([...PIN_OPEN_MODES], ["premiere", "liste"]);
  assert.equal(DEFAULT_PIN_OPEN, "premiere");
});

const one: LieuAuditionsKnown = { count: 1, first: "a1", top: "a1" };
const many: LieuAuditionsKnown = { count: 3, first: "n3", top: "o1" };
const opening = { newLieu: true, known: one, via: "map", mode: "premiere" } as const;

test("auditionToOpen: a lieu newly opened with one audition opens it, every way", () => {
  for (const via of ["map", "panel", "crumb"] as const) {
    for (const mode of PIN_OPEN_MODES) {
      assert.equal(auditionToOpen({ ...opening, via, mode }), "a1", `${via} ${mode}`);
      // Not embedded (lazy): still the newest, as before.
      const lazy = { count: 1, first: "a1", top: null };
      assert.equal(auditionToOpen({ ...opening, known: lazy, via, mode }), "a1");
    }
  }
});

test("auditionToOpen: several, from the pin, « premiere »: the top of its list", () => {
  assert.equal(auditionToOpen({ ...opening, known: many }), "o1");
  // Its list not embedded: wait for it, never the newest.
  assert.equal(auditionToOpen({ ...opening, known: { ...many, top: null } }), AWAIT_LIST);
});

test("auditionToOpen: several from its row or its crumb, or « liste »: its list", () => {
  assert.equal(auditionToOpen({ ...opening, known: many, via: "panel" }), null);
  assert.equal(auditionToOpen({ ...opening, known: many, via: "crumb" }), null);
  assert.equal(auditionToOpen({ ...opening, known: many, mode: "liste" }), null);
  assert.equal(auditionToOpen({ ...opening, known: { ...many, top: null }, mode: "liste" }), null);
});

test("auditionToOpen: the lieu already open: as it is (only the map comes back)", () => {
  for (const known of [one, many]) {
    for (const via of ["map", "panel", "crumb"] as const) {
      for (const mode of PIN_OPEN_MODES) {
        assert.equal(auditionToOpen({ newLieu: false, known, via, mode }), null);
      }
    }
  }
});

test("auditionToOpen: none, or nothing known: its list, as before", () => {
  for (const mode of PIN_OPEN_MODES) {
    const base = { ...opening, mode };
    assert.equal(auditionToOpen({ ...base, known: { count: 0, first: null, top: null } }), null);
    assert.equal(auditionToOpen({ ...base, known: { count: 1, first: null, top: null } }), null);
    assert.equal(auditionToOpen({ ...base, known: null }), null);
  }
});

/** #218's rule, before the pin opened anything for several. */
const before = (o: { newLieu: boolean; known: LieuAuditionsKnown | null }) =>
  !o.newLieu || !o.known ? null : o.known.count === 1 ? o.known.first : null;

test("auditionToOpen: « liste » is exactly the rule before, every case", () => {
  const knowns: (LieuAuditionsKnown | null)[] = [
    null,
    { count: 0, first: null, top: null },
    one,
    { count: 1, first: null, top: null },
    { count: 1, first: "a1", top: null },
    many,
    { ...many, top: null },
  ];
  for (const newLieu of [true, false]) {
    for (const known of knowns) {
      for (const via of ["map", "panel", "crumb"] as const) {
        const o = { newLieu, known, via, mode: "liste" } as const;
        assert.equal(auditionToOpen(o), before(o));
        // And the panel's rows and crumbs, under « premiere » too.
        if (via !== "map") assert.equal(auditionToOpen({ ...o, mode: "premiere" }), before(o));
      }
    }
  }
});
