// The scope-outline upload rule, run with `node --import tsx --test` (root
// "test:scripts"). Pure: no map, no Vue, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutlineFC } from "../types";
import { nextOutlineUpload, outlineToUpload } from "./outlineUpload";

type Kind = "scope" | "focus" | "context";

function fc(...kinds: Kind[]): OutlineFC {
  return {
    type: "FeatureCollection",
    features: kinds.map((kind, i) => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [] },
      properties: { kind, id: `u${i}` },
    })),
  };
}

const EMPTY: OutlineFC = { type: "FeatureCollection", features: [] };

test("world: no scope feature, nothing pending -> the outline goes up", () => {
  const world = fc("focus");
  assert.equal(outlineToUpload(world, false, EMPTY), world);
});

test("a level with its scope feature -> empty (a plateau is coming)", () => {
  assert.equal(outlineToUpload(fc("scope", "focus", "context"), false, EMPTY), EMPTY);
  assert.equal(outlineToUpload(fc("scope"), false, EMPTY), EMPTY);
});

test("cold hold (boundary pending, scope feature not there yet) -> empty", () => {
  assert.equal(outlineToUpload(fc("focus", "context"), true, EMPTY), EMPTY);
});

test("DROM / non-FR scopes: context and focus only, nothing pending -> uploaded", () => {
  const drom = fc("focus", "context", "context");
  const contextOnly = fc("context", "context");
  assert.equal(outlineToUpload(drom, false, EMPTY), drom);
  assert.equal(outlineToUpload(contextOnly, false, EMPTY), contextOnly);
});

test("the shared empty collection of the micropin zone -> the local empty one", () => {
  const shared: OutlineFC = { type: "FeatureCollection", features: [] };
  assert.equal(outlineToUpload(shared, false, EMPTY), EMPTY);
  assert.equal(outlineToUpload(shared, true, EMPTY), EMPTY);
});

test("null and undefined outlines -> empty", () => {
  assert.equal(outlineToUpload(null, false, EMPTY), EMPTY);
  assert.equal(outlineToUpload(undefined, false, EMPTY), EMPTY);
  assert.equal(outlineToUpload(undefined, true, EMPTY), EMPTY);
});

test("the same object follows pending, and the world comes back", () => {
  const world = fc("focus");
  assert.equal(outlineToUpload(world, false, EMPTY), world);
  assert.equal(outlineToUpload(world, true, EMPTY), EMPTY);
  assert.equal(outlineToUpload(world, false, EMPTY), world);
});

test("walk: world -> country -> region -> world writes at the world steps only", () => {
  const world = fc("focus");
  const country = fc("scope", "focus", "context");
  const region = fc("scope", "focus", "context");
  const world2 = fc("focus"); // a fresh object, as every recompute builds
  let uploaded = EMPTY;
  const writes: OutlineFC[] = [];
  for (const [outline, pending] of [
    [world, false],
    [country, true],
    [country, false],
    [region, false],
    [region, false],
    [world2, false],
  ] as const) {
    const next = nextOutlineUpload(uploaded, outline, pending, EMPTY);
    if (next) {
      writes.push(next);
      uploaded = next;
    }
  }
  // the world, then ONE empty write for every plateau step, then the world again
  assert.deepEqual(writes, [world, EMPTY, world2]);
});

test("nothing is written when the source already holds the answer", () => {
  const world = fc("focus");
  assert.equal(nextOutlineUpload(EMPTY, fc("scope"), false, EMPTY), null);
  assert.equal(nextOutlineUpload(EMPTY, undefined, false, EMPTY), null);
  assert.equal(nextOutlineUpload(world, world, false, EMPTY), null);
  assert.equal(nextOutlineUpload(EMPTY, world, false, EMPTY), world);
  assert.equal(nextOutlineUpload(world, world, true, EMPTY), EMPTY);
});

test("flat (no elevated terrain): every outline goes up, scope feature included", () => {
  const world = fc("focus");
  const country = fc("scope", "focus", "context");
  assert.equal(outlineToUpload(world, false, EMPTY, true), world);
  assert.equal(outlineToUpload(country, false, EMPTY, true), country);
  // The pure rule ignores pending; nextOutlineUpload holds.
  const level = fc("scope", "focus");
  assert.equal(outlineToUpload(level, true, EMPTY, true), level);
  assert.equal(outlineToUpload(fc(), false, EMPTY, true), EMPTY);
  assert.equal(outlineToUpload(null, false, EMPTY, true), EMPTY);
});

test("flat: pending holds what is up, the same object is not written again", () => {
  const world = fc("focus");
  const country = fc("scope", "focus", "context");
  assert.equal(nextOutlineUpload(world, country, true, EMPTY, true), null);
  assert.equal(nextOutlineUpload(world, country, false, EMPTY, true), country);
  assert.equal(nextOutlineUpload(country, country, false, EMPTY, true), null);
  assert.equal(nextOutlineUpload(country, fc(), false, EMPTY, true), EMPTY);
  assert.equal(nextOutlineUpload(EMPTY, undefined, false, EMPTY, true), null);
});
