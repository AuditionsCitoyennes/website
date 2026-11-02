// The plateau's line groups packed with one TypedArray.set each (meshConcat.ts,
// ac:mesh=concat) against the loop they replace in
// PlateauWallLayer.setGeometry, byte for byte: an element `!==` cannot see
// `-0` nor NaN, the bytes can. Run with `node --import tsx --test` (root
// "test:scripts"). Pure: no DOM, no alias at run time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { concatGroups } from "./meshConcat";

type Group = { verts: number[]; gVerts: number[] };

/** Today's assembly (PlateauWallLayer.setGeometry, ac:mesh=ancien), copied:
 *  the ranges, then both buffers as the layer stores them. */
function oracle(groups: Group[]) {
  const lineVerts: number[] = [];
  const gLine: number[] = [];
  const starts: number[] = [];
  for (const grp of groups) {
    const count = grp.verts.length / 8;
    if (!count) continue;
    starts.push(lineVerts.length / 8);
    for (const v of grp.verts) lineVerts.push(v);
    for (const v of grp.gVerts) gLine.push(v);
  }
  return { starts, lines: new Float32Array(lineVerts), gLines: new Float32Array(gLine) };
}

/** The layer's concat path: the same filter, then one buffer per regime. */
function packed(groups: Group[]) {
  const kept = groups.filter((grp) => grp.verts.length / 8);
  const lines = concatGroups(kept.map((grp) => grp.verts));
  const gLines = concatGroups(kept.map((grp) => grp.gVerts));
  return { starts: lines.starts.map((s) => s / 8), lines: lines.array, gLines: gLines.array };
}

const bytes = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

function assertSame(groups: Group[]) {
  const want = oracle(groups);
  const got = packed(groups);
  assert.deepEqual(got.starts, want.starts);
  assert.equal(got.lines.length, want.lines.length);
  assert.equal(got.gLines.length, want.gLines.length);
  assert.ok(bytes(got.lines).equals(bytes(want.lines)), "mercator lines differ");
  assert.ok(bytes(got.gLines).equals(bytes(want.gLines)), "globe lines differ");
}

/** A group of `n` line vertices (8 floats each, 20 on the globe), values
 *  from `seed`. */
function group(n: number, seed: number): Group {
  const verts = Array.from({ length: n * 8 }, (_, i) => Math.sin(seed * 977 + i) * 1e-3);
  const gVerts = Array.from({ length: n * 20 }, (_, i) => Math.cos(seed * 613 + i) * 6.4e6);
  return { verts, gVerts };
}

test("float32 rounding as new Float32Array: unrepresentable values, overflow, underflow, -0, NaN", () => {
  const odd = [0.1, 1e39, -1e39, 1e-46, -1e-46, -0, NaN, 0.30000000000000004];
  const verts = [...odd, ...odd.slice().reverse()]; // 16 floats = 2 vertices
  const gVerts = Array.from({ length: 40 }, (_, i) => odd[i % odd.length]);
  assertSame([{ verts, gVerts }, group(3, 1)]);
  const got = packed([{ verts, gVerts }]).lines;
  assert.equal(got[1], Infinity);
  assert.equal(got[3], 0);
  assert.ok(Object.is(got[4], -0)); // -1e-46 rounds to -0, kept
  assert.ok(Object.is(got[5], -0));
  assert.ok(Number.isNaN(got[6]));
});

test("an empty group in the middle is skipped by the caller, so the ranges stay aligned", () => {
  const groups = [group(6, 1), { verts: [], gVerts: [] }, group(12, 2), group(6, 3)];
  assertSame(groups);
  assert.deepEqual(packed(groups).starts, [0, 6, 18]);
  // Unfiltered, the empty group would take a range of its own and shift the
  // ones after it against the layer's ranges.
  assert.equal(concatGroups(groups.map((g) => g.verts)).starts.length, 4);
});

test("lengths not a multiple of 8, and the stride-20 globe set", () => {
  const ragged = [[1, 2, 3], [4, 5, 6, 7, 8], [9]].map((verts) => ({ verts, gVerts: verts }));
  const want = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const got = concatGroups(ragged.map((g) => g.verts));
  assert.ok(bytes(got.array).equals(bytes(want)));
  assert.deepEqual(got.starts, [0, 3, 8]);
  const globe = [group(2, 4), group(5, 5)];
  const g = concatGroups(globe.map((grp) => grp.gVerts));
  assert.deepEqual(g.starts, [0, 40]);
  assert.equal(g.array.length, 140);
  assertSame(globe);
});

test("no group at all: empty buffers, no range", () => {
  const got = concatGroups([]);
  assert.equal(got.array.length, 0);
  assert.deepEqual(got.starts, []);
  assertSame([]);
  assertSame([{ verts: [], gVerts: [] }]);
});

test("starts are the oracle's running offsets", () => {
  const groups = [group(1, 6), group(48, 7), group(6, 8), group(300, 9)];
  const got = concatGroups(groups.map((g) => g.verts));
  let offset = 0;
  const running = groups.map((g) => {
    const s = offset;
    offset += g.verts.length;
    return s;
  });
  assert.deepEqual(got.starts, running);
  assertSame(groups);
});
