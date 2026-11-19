// The « Témoigner » invitation (testifyNudge.ts), run with `node --import tsx
// --test` (root "test:scripts"): « Auto » invites a device that has sent no
// testimony for a week (or ever) and stays calm for seven days after one;
// « Toujours » and « Jamais » ignore the record; the record is one ISO date
// under "ac-last-testimony", read back with garbage and blocked storage as
// none; the switches are read only with the testing tools.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };
g.__TEST_TOOLS__ = false;
const nudge = await import("./testifyNudge");
const {
  CALM_MS,
  DEFAULT_TESTIFY_LOOK,
  DEFAULT_TESTIFY_NUDGE,
  LAST_TESTIMONY_KEY,
  TESTIFY_LOOKS,
  isWeeklyQuotaRefusal,
  TESTIFY_NUDGES,
  noteTestimony,
  nudgeDue,
  parseLastTestimony,
  storedLastTestimony,
} = nudge;

/** A wall clock in the middle of a real day. */
const NOW = Date.parse("2026-11-19T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

test("« Auto » invites without a record, and a week after the last testimony", () => {
  assert.equal(CALM_MS, 7 * DAY);
  assert.equal(nudgeDue("auto", null, NOW), true);
  assert.equal(nudgeDue("auto", NOW - 60_000, NOW), false);
  assert.equal(nudgeDue("auto", NOW - 6 * DAY, NOW), false);
  assert.equal(nudgeDue("auto", NOW - 7 * DAY + 1, NOW), false);
  assert.equal(nudgeDue("auto", NOW - 7 * DAY, NOW), true);
  assert.equal(nudgeDue("auto", NOW - 40 * DAY, NOW), true);
});

test("a record from a clock set ahead: calm within a day, ignored beyond", () => {
  assert.equal(nudgeDue("auto", NOW + DAY / 2, NOW), false);
  assert.equal(nudgeDue("auto", NOW + 2 * DAY, NOW), true);
});

test("« Toujours » and « Jamais » ignore the record", () => {
  for (const last of [null, NOW - 60_000, NOW - 30 * DAY]) {
    assert.equal(nudgeDue("toujours", last, NOW), true);
    assert.equal(nudgeDue("jamais", last, NOW), false);
  }
});

test("the defaults, and a build without the testing tools reads no switch", () => {
  assert.equal(DEFAULT_TESTIFY_NUDGE, "auto");
  assert.equal(DEFAULT_TESTIFY_LOOK, "lueur");
  assert.deepEqual([...TESTIFY_NUDGES], ["auto", "toujours", "jamais"]);
  assert.deepEqual([...TESTIFY_LOOKS], ["lueur", "anneau", "point"]);
  assert.equal(nudge.testifyNudge.value, "auto");
  assert.equal(nudge.testifyLook.value, "lueur");
  // The setters do nothing there.
  nudge.setTestifyNudge("jamais");
  nudge.setTestifyLook("point");
  assert.equal(nudge.testifyNudge.value, "auto");
  assert.equal(nudge.testifyLook.value, "lueur");
});

test("the record is an ISO date, garbage reads as none", () => {
  assert.equal(LAST_TESTIMONY_KEY, "ac-last-testimony");
  assert.equal(parseLastTestimony(null), null);
  assert.equal(parseLastTestimony(""), null);
  assert.equal(parseLastTestimony("hier"), null);
  assert.equal(parseLastTestimony("2026-11-12T10:00:00.000Z"), NOW - 7 * DAY);
});

test("a testimony is kept on the device, and read back; blocked storage keeps it for the page", () => {
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  try {
    assert.equal(storedLastTestimony(), null);
    noteTestimony(NOW);
    assert.equal(store.get(LAST_TESTIMONY_KEY), "2026-11-19T10:00:00.000Z");
    assert.equal(nudge.lastTestimonyAt.value, NOW);
    assert.equal(storedLastTestimony(), NOW);
    assert.equal(nudgeDue("auto", nudge.lastTestimonyAt.value, NOW + 60_000), false);
    // Nothing else is written.
    assert.deepEqual([...store.keys()], [LAST_TESTIMONY_KEY]);

    g.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(storedLastTestimony(), null);
    noteTestimony(NOW + DAY);
    assert.equal(nudge.lastTestimonyAt.value, NOW + DAY);
  } finally {
    delete g.localStorage;
  }
});

test("the API's once-a-week refusal is told apart from its other 429", () => {
  const weekly =
    "Un seul témoignage par semaine et par adresse email : cette adresse en a déjà envoyé un ces 7 derniers jours.";
  assert.equal(isWeeklyQuotaRefusal(429, weekly), true);
  assert.equal(
    isWeeklyQuotaRefusal(
      429,
      "Le dépôt de témoignages est momentanément saturé. Réessayez plus tard.",
    ),
    false,
  );
  assert.equal(isWeeklyQuotaRefusal(400, weekly), false);
});
