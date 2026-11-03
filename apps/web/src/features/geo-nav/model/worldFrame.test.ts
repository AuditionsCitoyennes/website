// The world's frame (worldFrame.ts). Run with `node --import tsx --test` (root
// "test:scripts"). Pure: the module has type-only imports.

import assert from "node:assert/strict";
import { test } from "node:test";
import { worldFrame, WORLD_ZOOM } from "./worldFrame";

const box = (minLat: number, maxLat: number, minLng: number, maxLng: number) => ({
  minLat,
  maxLat,
  minLng,
  maxLng,
});
// Metropolitan France's frame (geo's METRO_FRANCE, about), then with Spain's
// Canaries, Madagascar, South Africa's Prince Edward Islands, Russia and Brazil.
const FR = box(41.3, 51.1, -5.2, 9.6);
const FR_ES = box(27.6, 51.1, -18.2, 9.6);
const FR_MG = box(-25.6, 51.1, -5.2, 50.5);
const FR_ZA = box(-47, 51.1, -5.2, 38);
const WIDE = box(-33.8, 81.9, -74, 191);

test("France alone, and with Spain: the inflated box is fitted", () => {
  const f = worldFrame(FR);
  assert.ok(f.type === "fit" && Math.abs(f.bounds.minLat - (41.3 - 9.8 * 0.6)) < 1e-9);
  assert.equal(worldFrame(FR_ES).type, "fit");
});

test("a world past mercator's latitudes, or wider than the globe, is eased whole", () => {
  for (const b of [FR_MG, FR_ZA, WIDE]) {
    const f = worldFrame(b);
    assert.ok(f.type === "ease", JSON.stringify(b));
    assert.equal(f.zoom, WORLD_ZOOM);
    assert.ok(Math.abs(f.center[1] - (b.minLng + b.maxLng) / 2) < 1e-9);
    assert.ok(f.center[0] >= -60 && f.center[0] <= 60);
  }
  // Madagascar's lng span is 55.7°, inflated 122°: under 180, eased on latitude.
  assert.equal((worldFrame(FR_MG) as { center: number[] }).center[0], 0);
});
