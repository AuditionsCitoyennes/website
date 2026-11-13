// The plateau lid's budget from the screen (lidTier.ts): the floor of a
// select's pre-flight shot and the ceiling of the refines, per device. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no DOM, no alias at
// run time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { lidTier, shotPixels, type LidTier } from "./lidTier";

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

/** The shot's size as mapSnapshot computed it before shotPixels. */
function before(wantPx: number, hardMax: number, tier: LidTier, noHardMax: number): number {
  const ceil = Math.min(tier.ceiling, hardMax > 0 ? hardMax : noHardMax);
  const want = Math.ceil(Math.max(wantPx, 1) / 256) * 256;
  return Math.max(Math.min(want, ceil), Math.min(tier.floor, ceil));
}

test("shotPixels: at the screen's ratio, the size mapSnapshot always computed", () => {
  const tiers: LidTier[] = [
    { floor: 1280, ceiling: 2048 },
    { floor: 1024, ceiling: 1024 },
    { floor: 2048, ceiling: 4096 },
    { floor: 1792, ceiling: 4096 },
  ];
  for (const tier of tiers) {
    for (const want of [0, 1, 255, 256, 257, 700, 1024, 1500, 2048, 3000, 4096, 9000]) {
      for (const hardMax of [0, 1024, 2048, 4096, 8192, 16384]) {
        const was = before(want, hardMax, tier, 2048);
        assert.equal(shotPixels(want, hardMax, tier, 2048), was);
        assert.equal(shotPixels(want, hardMax, tier, 2048, 1), was);
        // A ratio under 1 (never asked for) is read as 1.
        assert.equal(shotPixels(want, hardMax, tier, 2048, 0.5), was);
      }
    }
  }
});

test("shotPixels: maps drawn at 1.5 on a screen at 3 take half the pixels a side", () => {
  // The audit's phone, 360×740 at 3: floor 1280, refines stopped at 2048.
  const tier = lidTier({ innerW: 360, innerH: 740, dpr: 3, coarse: true });
  assert.deepEqual(tier, { floor: 1280, ceiling: 2048 });
  // A select's pre-flight shot (want 0): the floor, 1280 screen px → 640.
  assert.equal(shotPixels(0, 16384, tier, 2048), 1280);
  assert.equal(shotPixels(0, 16384, tier, 2048, 2), 640);
  // A want sized against the capped canvas (half the pixels of the screen's):
  // the same screen size as the uncapped want, at half the pixels.
  assert.equal(shotPixels(1500, 16384, tier, 2048), 1536);
  assert.equal(shotPixels(750, 16384, tier, 2048, 2), 768);
  // The ceiling holds in screen pixels: 2048 → 1024.
  assert.equal(shotPixels(9000, 16384, tier, 2048), 2048);
  assert.equal(shotPixels(4500, 16384, tier, 2048, 2), 1024);
  // GL_MAX_TEXTURE_SIZE holds in the canvas's own pixels.
  assert.equal(shotPixels(4500, 512, tier, 2048, 2), 512);
  // Not read yet: the fallback, a screen size.
  assert.equal(shotPixels(4500, 0, tier, 1024, 2), 512);
  // A ratio that is not a round number.
  assert.equal(shotPixels(0, 16384, tier, 2048, 2.625 / 1.5), Math.round(1280 / (2.625 / 1.5)));
});
