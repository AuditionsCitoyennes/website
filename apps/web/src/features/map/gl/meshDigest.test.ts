// The plateau mesh's fingerprint (meshDigest.ts): FNV-1a 32-bit vectors, a
// typed array hashed by its bytes, a missing array as "absent". Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no alias at
// run time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { digestParts, fnv1a, hashPart } from "./meshDigest";

const utf8 = (s: string) => new TextEncoder().encode(s);

test("FNV-1a 32-bit vectors", () => {
  assert.equal(fnv1a(new Uint8Array(0)), 0x811c9dc5);
  assert.equal(fnv1a(utf8("a")), 0xe40c292c);
  assert.equal(fnv1a(utf8("foobar")), 0xbf9cf968);
  assert.equal(hashPart(""), "811c9dc5");
  assert.equal(hashPart("a"), "e40c292c");
});

test("a typed array is hashed by its bytes, its view's own window only", () => {
  const a = new Float32Array([0.1, -0, NaN, 1e39]);
  const asBytes = new Uint8Array(a.buffer.slice(0));
  assert.equal(hashPart(a), hashPart(asBytes));
  assert.equal(hashPart(a), fnv1a(asBytes).toString(16).padStart(8, "0"));
  // -0 and 0 are equal values, different bytes.
  assert.notEqual(hashPart(new Float32Array([-0])), hashPart(new Float32Array([0])));
  // A view into a larger buffer hashes its own bytes, not the buffer's.
  const big = new Float64Array([1, 2, 3, 4]);
  assert.equal(hashPart(new Float64Array(big.buffer, 8, 2)), hashPart(new Float64Array([2, 3])));
});

test('null or absent hashes as the literal part "absent"', () => {
  assert.equal(hashPart(null), hashPart("absent"));
  assert.equal(hashPart(undefined), hashPart("absent"));
  assert.notEqual(hashPart(null), hashPart(new Float32Array(0)));
});

test("the total follows every part, in the order given", () => {
  const one = digestParts([
    ["positions", new Float32Array([1, 2])],
    ["state", "{}"],
  ]);
  assert.deepEqual(Object.keys(one.parts), ["positions", "state"]);
  assert.equal(one.parts.positions, hashPart(new Float32Array([1, 2])));
  const changed = digestParts([
    ["positions", new Float32Array([1, 3])],
    ["state", "{}"],
  ]);
  assert.notEqual(one.total, changed.total);
  assert.equal(changed.parts.state, one.parts.state);
  const swapped = digestParts([
    ["state", "{}"],
    ["positions", new Float32Array([1, 2])],
  ]);
  assert.notEqual(one.total, swapped.total);
});
