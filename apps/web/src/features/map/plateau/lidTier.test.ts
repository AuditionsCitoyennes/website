// The plateau lid's budget from the screen (lidTier.ts): the floor of a
// select's pre-flight shot and the ceiling of the refines, per device. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no alias at
// run time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { lidTier } from "./lidTier";

test("a phone: the floor from its short side, the refines stopped at 2048", () => {
  // iPhone 15 (Safari: no deviceMemory).
  assert.deepEqual(lidTier({ innerW: 393, innerH: 852, dpr: 3, coarse: true }), {
    floor: 1280,
    ceiling: 2048,
  });
  // Pixel 8.
  assert.deepEqual(
    lidTier({ innerW: 412, innerH: 915, dpr: 2.625, deviceMemory: 8, coarse: true }),
    { floor: 1280, ceiling: 2048 },
  );
});

test("a known low-memory device keeps the flat 1024", () => {
  assert.deepEqual(
    lidTier({ innerW: 412, innerH: 915, dpr: 2.625, deviceMemory: 4, coarse: true }),
    { floor: 1024, ceiling: 1024 },
  );
  assert.deepEqual(lidTier({ innerW: 1512, innerH: 982, dpr: 2, deviceMemory: 2, coarse: false }), {
    floor: 1024,
    ceiling: 1024,
  });
});

test("a laptop: today's 2048/4096 where the screen needs them", () => {
  // MacBook 14".
  assert.deepEqual(lidTier({ innerW: 1512, innerH: 982, dpr: 2, deviceMemory: 8, coarse: false }), {
    floor: 2048,
    ceiling: 4096,
  });
  // The baseline laptop.
  assert.deepEqual(lidTier({ innerW: 1280, innerH: 800, dpr: 2, deviceMemory: 8, coarse: false }), {
    floor: 1792,
    ceiling: 4096,
  });
});

test("a 1080p desktop at dpr 1: the floor from 1080, the ceiling from 1.7× its width", () => {
  // 1.7 × 1920 = 3264, rounded up to 256.
  assert.deepEqual(
    lidTier({ innerW: 1920, innerH: 1080, dpr: 1, deviceMemory: 8, coarse: false }),
    { floor: 1280, ceiling: 3328 },
  );
});

test("the bounds: 1024 at least, 2048 at most for the floor, 4096 for the ceiling", () => {
  assert.deepEqual(lidTier({ innerW: 320, innerH: 240, dpr: 1, coarse: false }), {
    floor: 1024,
    ceiling: 1024,
  });
  assert.deepEqual(lidTier({ innerW: 3840, innerH: 2160, dpr: 2, coarse: false }), {
    floor: 2048,
    ceiling: 4096,
  });
  // A touch laptop's wide window is not a phone: the short side decides.
  assert.deepEqual(lidTier({ innerW: 1280, innerH: 800, dpr: 2, coarse: true }), {
    floor: 1792,
    ceiling: 4096,
  });
});
