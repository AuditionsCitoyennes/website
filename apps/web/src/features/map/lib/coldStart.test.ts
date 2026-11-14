// What starts while the map holds for an outline on its way (coldStart.ts).
// Run with `node --import tsx --test` (root "test:scripts"). Pure: no Vue,
// no DOM, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { boxCovers, boxFeature, coldStartPlan, type ColdStartState } from "./coldStart";

const ARA = { id: "fr:reg:84", bounds: { minLat: 44.1, maxLat: 46.8, minLng: 2.06, maxLng: 7.19 } };
const state = (over: Partial<ColdStartState> = {}): ColdStartState => ({
  mode: "early",
  coming: ARA,
  standingId: "FR",
  standingUp: true,
  ...over,
});

test("hold: nothing starts, whatever stands", () => {
  assert.deepEqual(coldStartPlan(state({ mode: "hold" })), { sink: false, lid: null });
  assert.deepEqual(coldStartPlan(state({ mode: "hold", standingId: "", standingUp: false })), {
    sink: false,
    lid: null,
  });
});

test("early: the plateau standing sinks and the lid is shot over the coming unit's box", () => {
  assert.deepEqual(coldStartPlan(state()), { sink: true, lid: ARA.bounds });
});

test("early, nothing standing: no sink, the lid shot all the same", () => {
  assert.deepEqual(coldStartPlan(state({ standingId: "", standingUp: false })), {
    sink: false,
    lid: ARA.bounds,
  });
  // A plateau already sunk (a sink cut short, a hold run a second time).
  assert.deepEqual(coldStartPlan(state({ standingUp: false })), { sink: false, lid: ARA.bounds });
});

test("early: nothing for a unit not known, nor for the unit that stands", () => {
  assert.deepEqual(coldStartPlan(state({ coming: null })), { sink: false, lid: null });
  assert.deepEqual(coldStartPlan(state({ coming: undefined })), { sink: false, lid: null });
  assert.deepEqual(coldStartPlan(state({ coming: { ...ARA, id: "" } })), {
    sink: false,
    lid: null,
  });
  assert.deepEqual(coldStartPlan(state({ standingId: ARA.id })), { sink: false, lid: null });
});

test("early: a box with no extent sinks the old plateau but shoots no lid", () => {
  const flat = { minLat: 45, maxLat: 45, minLng: 2, maxLng: 7 };
  assert.deepEqual(coldStartPlan(state({ coming: { id: "x", bounds: flat } })), {
    sink: true,
    lid: null,
  });
  const nan = { minLat: Number.NaN, maxLat: 46, minLng: 2, maxLng: 7 };
  assert.deepEqual(coldStartPlan(state({ coming: { id: "x", bounds: nan } })).lid, null);
});

test("the box as a feature: a closed counter-clockwise rectangle over exactly that box", () => {
  const f = boxFeature(ARA);
  assert.equal(f.properties.id, ARA.id);
  assert.equal(f.properties.kind, "scope");
  const ring = f.geometry.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  assert.equal(Math.min(...lngs), ARA.bounds.minLng);
  assert.equal(Math.max(...lngs), ARA.bounds.maxLng);
  assert.equal(Math.min(...lats), ARA.bounds.minLat);
  assert.equal(Math.max(...lats), ARA.bounds.maxLat);
  // Counter-clockwise: a positive signed area (RFC 7946 exteriors).
  let area = 0;
  for (let i = 0; i < 4; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  assert.ok(area > 0);
});

test("a box covers the fine outline's own box and a coarser outline's, not a larger one", () => {
  const b = ARA.bounds;
  assert.equal(boxCovers(b, { ...b }), true);
  // The fr1000 entry of the same région: a few metres inside.
  assert.equal(
    boxCovers(b, { ...b, minLat: b.minLat + 0.00014, maxLng: b.maxLng - 0.00043 }),
    true,
  );
  assert.equal(boxCovers(b, { ...b, maxLng: b.maxLng + 0.001 }), false);
  assert.equal(boxCovers(b, { ...b, minLat: b.minLat - 0.001 }), false);
  assert.equal(boxCovers(b, null), false);
  assert.equal(boxCovers(b, undefined), false);
});
