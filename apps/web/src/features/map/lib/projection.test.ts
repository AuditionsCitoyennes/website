// The projection caches' probe (projection.ts, setProjectionProbe): the page's
// projection.ringBases / projection.lidBases spans, kept now that the module
// imports no perf tools. One call per cache miss, with the vertices the span
// reported before; none on a hit; none with no probe. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { lidBasesOf, ringBasesOf, setProjectionProbe, type ProjectionProbe } from "./projection";

type Call = { name: string; vertices?: number };

/** A probe that logs each miss and the detail its end is given. */
function recorder(): { probe: ProjectionProbe; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    probe: (name) => {
      const call: Call = { name };
      calls.push(call);
      return (detail) => {
        assert.equal(call.vertices, undefined, "an end is called once");
        call.vertices = detail.vertices;
      };
    },
  };
}

/** A fresh geometry (the caches are keyed by identity): two squares, one with a hole. */
const square = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];
const geometry = () => ({
  type: "MultiPolygon",
  coordinates: [[square(4, 45, 1), square(4.25, 45.25, 0.5).reverse()], [square(6, 45, 0.2)]],
});

test("one ringBases call per miss, with its vertices; none on a hit", () => {
  const { probe, calls } = recorder();
  setProjectionProbe(probe);
  try {
    const g = geometry();
    const bases = ringBasesOf(g);
    assert.deepEqual(calls, [{ name: "projection.ringBases", vertices: 15 }]);
    assert.equal(
      bases.flat().reduce((n, ring) => n + ring.length, 0),
      15,
    );
    assert.equal(ringBasesOf(g), bases);
    assert.equal(calls.length, 1);
  } finally {
    setProjectionProbe(null);
  }
});

test("one lidBases call per miss (its rings' miss inside it); none on a hit", () => {
  const { probe, calls } = recorder();
  setProjectionProbe(probe);
  try {
    const g = geometry();
    const lid = lidBasesOf(g);
    const vertices = lid.reduce((n, poly) => n + poly.length, 0);
    assert.ok(vertices > 0);
    assert.deepEqual(calls, [
      { name: "projection.lidBases", vertices },
      { name: "projection.ringBases", vertices: 15 },
    ]);
    assert.equal(lidBasesOf(g), lid);
    ringBasesOf(g);
    assert.equal(calls.length, 2);
    // A geometry whose rings are cached already: the lid's miss alone.
    const h = geometry();
    ringBasesOf(h);
    calls.length = 0;
    lidBasesOf(h);
    assert.deepEqual(calls, [{ name: "projection.lidBases", vertices }]);
  } finally {
    setProjectionProbe(null);
  }
});

test("no probe: the misses report nowhere", () => {
  const { probe, calls } = recorder();
  setProjectionProbe(probe);
  setProjectionProbe(null);
  const g = geometry();
  lidBasesOf(g);
  ringBasesOf(geometry());
  assert.equal(calls.length, 0);
});
