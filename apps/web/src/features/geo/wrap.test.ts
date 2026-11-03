// The antimeridian rules (wrap.ts) on boxes and geometries shaped as the
// build's unwrapped countries. Run with `node --import tsx --test` (root
// "test:scripts"). Pure: no Vue, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { boxesMeet, canonicalCopies, lngNear, type WrapGeometry } from "./wrap";
import type { Bounds } from "./types";

const box = (minLng: number, minLat: number, maxLng: number, maxLat: number): Bounds => ({
  minLat,
  maxLat,
  minLng,
  maxLng,
});
const RU = box(19.6387, 41.1851, 190.99232, 81.85905);
const US = box(-187.55475, 18.91069, -66.94974, 71.38683);
const ES = box(-18.15676, 27.63774, 4.32803, 43.79035);
const square = (lng: number, lat: number, r = 1) => [
  [lng - r, lat - r],
  [lng + r, lat - r],
  [lng + r, lat + r],
  [lng - r, lat + r],
  [lng - r, lat - r],
];

test("lngNear: the copy of a point nearest a box past ±180", () => {
  assert.equal(lngNear(-175, RU), 185); // Chukotka, east of 180
  assert.equal(lngNear(37.6, RU), 37.6); // Moscow
  assert.equal(lngNear(172.9, US), -187.1); // Attu, west of −180
  assert.equal(lngNear(-77, US), -77);
  for (const lng of [-179.9, -3.7, 0, 179.9]) assert.equal(lngNear(lng, ES), lng); // in range
});

test("boxesMeet: across the antimeridian, a box shifted a world east or west", () => {
  assert.equal(boxesMeet(RU, US), true); // the Bering Strait
  assert.equal(boxesMeet(US, RU), true);
  assert.equal(boxesMeet(ES, RU), false);
  assert.equal(boxesMeet(box(160, 50, 179, 70), US), true); // Kamchatka-like at −187
  assert.equal(boxesMeet(ES, box(-5, 41, 9, 51)), true);
  assert.equal(boxesMeet(ES, box(170, 41, 175, 51)), false); // no shift for boxes in range
});

test("canonicalCopies: polygons moved whole into range, one copy per source", () => {
  const inRange: WrapGeometry = { type: "Polygon", coordinates: [square(10, 50)] };
  assert.equal(canonicalCopies(inRange), inRange); // nothing to move: the same object
  const beyond: WrapGeometry = { type: "Polygon", coordinates: [square(185, 65)] };
  const c = canonicalCopies(beyond);
  assert.notEqual(c, beyond);
  assert.deepEqual(c.coordinates[0][0], [184 - 360, 64]);
  assert.equal(canonicalCopies(beyond), c); // identity-stable
  assert.equal(canonicalCopies(c), c); // idempotent on canonical input
  assert.deepEqual(beyond.coordinates[0][0], [184, 64]); // the source untouched
  const mixed: WrapGeometry = {
    type: "MultiPolygon",
    coordinates: [[square(100, 60)], [square(-186, 52), square(-186, 52, 0.5)]],
  };
  const m = canonicalCopies(mixed) as Extract<WrapGeometry, { type: "MultiPolygon" }>;
  assert.equal(m.coordinates[0], mixed.coordinates[0]); // an in-range polygon is shared
  assert.deepEqual(m.coordinates[1][0][0], [-187 + 360, 51]);
  assert.deepEqual(m.coordinates[1][1][0], [-186.5 + 360, 51.5]); // its hole moved with it
  for (const poly of m.coordinates)
    for (const ring of poly) for (const [lng] of ring) assert.ok(lng >= -180 && lng <= 180);
});

test("canonicalCopies: a polygon the build merged across 180 is cut there", () => {
  // Russia's mainland with Chukotka, 27 … 190, a hole on each side.
  const merged: WrapGeometry = {
    type: "Polygon",
    coordinates: [
      [
        [170, 60],
        [190, 60],
        [190, 70],
        [170, 70],
        [170, 60],
      ],
      square(175, 65, 1),
      square(185, 65, 1),
    ],
  };
  const c = canonicalCopies(merged);
  assert.equal(c.type, "MultiPolygon");
  const [west, east] = (c as Extract<WrapGeometry, { type: "MultiPolygon" }>).coordinates;
  assert.deepEqual(west[0], [
    [170, 60],
    [180, 60],
    [180, 70],
    [170, 70],
    [170, 60],
  ]);
  assert.deepEqual(east[0], [
    [-180, 60],
    [-170, 60],
    [-170, 70],
    [-180, 70],
    [-180, 60],
  ]);
  assert.equal(west.length, 2); // its hole at 175
  assert.equal(east.length, 2); // its hole at 185, now −175
  assert.deepEqual(east[1][0], [-176, 64]);
  for (const poly of [west, east])
    for (const ring of poly) for (const [lng] of ring) assert.ok(lng >= -180 && lng <= 180);
});
