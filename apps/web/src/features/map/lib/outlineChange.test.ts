// What a new outline asks of the plateau (outlineChange.ts). Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  linesOf,
  outlineVerdict,
  raisedShapeOf,
  retryVerdict,
  type OutlineFeatureLike,
  type PlateauState,
} from "./outlineChange";

const geo = (name: string) => ({ type: "Polygon", name });
const RHONE = geo("rhône");
const LYON = geo("lyon");
const AIN = geo("ain");
const feature = (
  kind: string,
  id: string,
  geometry: unknown,
  more: Record<string, unknown> = {},
): OutlineFeatureLike => ({
  geometry,
  properties: { kind, id, level: "dep", heightClass: "dep", ...more },
});
const scope = feature("scope", "fr:dep:69", RHONE);
const lyon = feature("focus", "fr:com:69123", LYON, { level: "city" });
const ain = feature("context", "fr:dep:01", AIN);

/** The plateau standing for `features`, dressed with their lines. */
const standingFor = (features: OutlineFeatureLike[]): PlateauState => ({
  standing: raisedShapeOf(features),
  running: null,
  dressed: linesOf(features),
});
const NOTHING_UP: PlateauState = { standing: null, running: null, dressed: [] };

test("nothing stands: an outline with a unit to raise runs the pipeline", () => {
  assert.equal(outlineVerdict([scope, ain], NOTHING_UP), "run");
});

test("no unit to raise (the world, a hold on a file): the pipeline's call", () => {
  assert.equal(outlineVerdict([], standingFor([scope])), "run");
  assert.equal(outlineVerdict([lyon, ain], standingFor([scope])), "run");
});

test("the fresh-object rule: the same content, as new objects, does nothing while the plateau stands", () => {
  const state = standingFor([scope, lyon, ain]);
  // A recompute: new feature objects and a new array, the same geometry objects.
  const again = [scope, lyon, ain].map((f) => ({ ...f, properties: { ...f.properties } }));
  assert.equal(outlineVerdict(again, state), "nothing");
});

test("the fresh-object rule: after a teardown the same content raises the plateau again", () => {
  const features = [scope, lyon, ain];
  const state = standingFor(features);
  assert.equal(outlineVerdict(features, state), "nothing");
  // The plateau went (cleared, failed, its terrain torn down, a sink cut
  // short): the state says so, and the very same outline is a run again.
  assert.equal(outlineVerdict(features, { ...state, standing: null }), "run");
  assert.equal(outlineVerdict([...features], { ...NOTHING_UP, dressed: state.dressed }), "run");
});

test("only the lines changed around a standing plateau: one reshape in place", () => {
  const state = standingFor([scope, ain]);
  assert.equal(outlineVerdict([scope, lyon, ain], state), "redress"); // its children landed
  assert.equal(outlineVerdict([scope], state), "redress"); // a line left
  const refined = feature("context", "fr:dep:01", geo("ain, finer"));
  assert.equal(outlineVerdict([scope, refined], state), "redress"); // a neighbour refined
  assert.equal(
    outlineVerdict([scope, { ...ain, properties: { ...ain.properties, level: "region" } }], state),
    "redress",
  );
});

test("the lines are compared in the wall's order, focus then context", () => {
  const state = standingFor([scope, lyon, ain]);
  assert.equal(outlineVerdict([ain, scope, lyon], state), "nothing");
  const villeurbanne = feature("focus", "fr:com:69266", geo("villeurbanne"), { level: "city" });
  assert.equal(
    outlineVerdict([scope, villeurbanne, lyon, ain], standingFor([scope, lyon, villeurbanne, ain])),
    "redress",
  );
});

test("another unit, another shape or another height for the same unit: the pipeline", () => {
  const state = standingFor([scope, ain]);
  assert.equal(outlineVerdict([feature("scope", "fr:dep:01", AIN)], state), "run");
  // Its own outline refined (the file landed after a rise on the coarse one).
  assert.equal(
    outlineVerdict([feature("scope", "fr:dep:69", geo("rhône, finer")), ain], state),
    "run",
  );
  assert.equal(
    outlineVerdict([feature("scope", "fr:dep:69", RHONE, { heightClass: "region" }), ain], state),
    "run",
  );
  // Two shapes to raise is not a case the reshape knows.
  assert.equal(outlineVerdict([scope, feature("scope", "fr:dep:01", AIN)], state), "run");
});

test("a run under way for this very shape is left alone; for another, it is replaced", () => {
  const running = raisedShapeOf([scope])!;
  const before: PlateauState = { standing: null, running, dressed: [] };
  assert.equal(outlineVerdict([scope, lyon, ain], before), "owed");
  // …also once it has committed and is rising.
  assert.equal(outlineVerdict([scope, lyon], { ...standingFor([scope]), running }), "owed");
  assert.equal(outlineVerdict([feature("scope", "fr:dep:01", AIN)], before), "run");
  // The old plateau still up while the new unit's run is under way: the old
  // unit selected again is a run (it brings it back up), not "nothing".
  const old = standingFor([feature("scope", "fr:dep:01", AIN)]);
  assert.equal(outlineVerdict([feature("scope", "fr:dep:01", AIN)], { ...old, running }), "run");
});

test("a plateau asked once more: run again unless its run is under way or it stands", () => {
  const rhone = raisedShapeOf([scope])!;
  assert.equal(retryVerdict("fr:dep:69", NOTHING_UP), "rerun");
  assert.equal(retryVerdict("fr:dep:69", { standing: null, running: rhone }), "running");
  assert.equal(retryVerdict("fr:dep:69", standingFor([scope])), "standing");
  // Committed and still rising: under way.
  assert.equal(retryVerdict("fr:dep:69", { ...standingFor([scope]), running: rhone }), "running");
  // Another unit's run, another unit's plateau: neither is this one's.
  const ainUp = standingFor([feature("scope", "fr:dep:01", AIN)]);
  assert.equal(retryVerdict("fr:dep:69", ainUp), "rerun");
  assert.equal(retryVerdict("fr:dep:69", { standing: null, running: ainUp.standing }), "rerun");
});
