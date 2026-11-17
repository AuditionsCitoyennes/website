// When a plateau's rise can start (riseEta.ts): every branch. Clocks at a
// realistic page age. Run with `node --import tsx --test` (root
// "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { riseEta, type RiseEtaInputs } from "./riseEta";

const NOW = 60_000;
const base: RiseEtaInputs = {
  now: NOW,
  running: true,
  sinkEndAt: 0,
  holdEndAt: 0,
  order: "flight",
  flying: false,
  flightEndAt: 0,
};

test("no run and no plateau for the unit: not known", () => {
  assert.equal(riseEta({ ...base, running: false }), null);
  assert.equal(
    riseEta({ ...base, running: false, sinkEndAt: NOW + 100, flightEndAt: NOW + 500 }),
    null,
  );
});

test("nothing holds the rise: now", () => {
  assert.deepEqual(riseEta(base), { at: NOW, landing: false });
  // A sink or a hold already over counts for nothing.
  assert.deepEqual(riseEta({ ...base, sinkEndAt: NOW - 40, holdEndAt: NOW - 5 }), {
    at: NOW,
    landing: false,
  });
});

test("the old plateau's sink, a hold before the commit: the later of them", () => {
  assert.deepEqual(riseEta({ ...base, sinkEndAt: NOW + 120 }), { at: NOW + 120, landing: false });
  assert.deepEqual(riseEta({ ...base, holdEndAt: NOW + 60 }), { at: NOW + 60, landing: false });
  assert.deepEqual(riseEta({ ...base, sinkEndAt: NOW + 120, holdEndAt: NOW + 60 }), {
    at: NOW + 120,
    landing: false,
  });
});

test("the rise plays during the flight: the flight counts for nothing", () => {
  assert.deepEqual(
    riseEta({ ...base, flying: true, flightEndAt: NOW + 500, sinkEndAt: NOW + 100 }),
    { at: NOW + 100, landing: false },
  );
});

test("the rise waits for the landing: the flight's known end, when it is the last thing waited for", () => {
  const after = { ...base, order: "after" as const };
  assert.deepEqual(riseEta({ ...after, flying: true, flightEndAt: NOW + 500 }), {
    at: NOW + 500,
    landing: true,
  });
  // The sink ends after the flight: not a landing.
  assert.deepEqual(
    riseEta({ ...after, flying: true, flightEndAt: NOW + 100, sinkEndAt: NOW + 140 }),
    { at: NOW + 140, landing: false },
  );
  // No flight in the air: as during the flight.
  assert.deepEqual(riseEta({ ...after, flightEndAt: NOW + 500 }), { at: NOW, landing: false });
});

test("the rise waits for a landing whose end is not known: not known", () => {
  assert.equal(riseEta({ ...base, order: "after", flying: true, flightEndAt: 0 }), null);
});
