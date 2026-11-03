// The map's polygon boxes (polygon.ts) on geometry past ±180° (the unwrapped
// countries of the outline files). Run with `node --import tsx --test` (root
// "test:scripts"). Pure: the module has type-only imports.

import assert from "node:assert/strict";
import { test } from "node:test";
import { boundsOfFeatures, buildHitRings, hitTest, ringBounds } from "./polygon";
import type { OutlineFC } from "../types";

// Chukotka-like, wholly east of 180 (Russia's unwrapped outline), and an
// Aleutian-like ring wholly west of −180 (the United States').
const EAST = [
  [181, 64],
  [189, 64],
  [189, 70],
  [181, 70],
  [181, 64],
];
const WEST = [
  [-187.5, 51],
  [-182, 51],
  [-182, 53],
  [-187.5, 53],
  [-187.5, 51],
];
const feature = (ring: number[][]): OutlineFC["features"][number] => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [ring] },
  properties: { kind: "scope", id: "RU", level: "country", heightClass: "full" },
});

test("a ring wholly past ±180 gets its true box", () => {
  assert.deepEqual(ringBounds(EAST), { minLat: 64, maxLat: 70, minLng: 181, maxLng: 189 });
  assert.deepEqual(ringBounds(WEST), { minLat: 51, maxLat: 53, minLng: -187.5, maxLng: -182 });
  const [east] = buildHitRings({ type: "Polygon", coordinates: [EAST] });
  assert.deepEqual([east.minLng, east.maxLng, east.minLat, east.maxLat], [181, 189, 64, 70]);
  assert.equal(hitTest([east], 185, 67), true);
  assert.deepEqual(boundsOfFeatures([feature(EAST), feature(WEST)]), {
    minLat: 51,
    maxLat: 70,
    minLng: -187.5,
    maxLng: 189,
  });
  assert.equal(boundsOfFeatures([]), null);
});
