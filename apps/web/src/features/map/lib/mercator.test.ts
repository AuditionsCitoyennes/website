// The closed-form projection (mercator.ts) against the live mapbox-gl it
// replays, called exactly as lib/projection.ts called it before: two
// MercatorCoordinate.fromLngLat and two LngLat.toEcef per vertex. Every
// component is compared with Object.is (it sees -0, and NaN), x, y, zPerM, lo
// AND d: bit-identical bases make every mesh identical by construction. Run
// with `node --import tsx --test` (root "test:scripts"); mapbox-gl's dist
// loads in plain Node.

import assert from "node:assert/strict";
import { test } from "node:test";
import mapboxgl from "mapbox-gl";
import { baseOf, type PBase } from "./mercator";

/** The old baseOf (projection.ts before mercator.ts), verbatim. */
function mapboxBaseOf(lng: number, lat: number): PBase {
  const m0 = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, 0);
  const m1 = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, 1);
  const ll = new mapboxgl.LngLat(lng, lat) as mapboxgl.LngLat & {
    toEcef(altM: number): [number, number, number];
  };
  const lo = ll.toEcef(0);
  const e1 = ll.toEcef(1);
  return {
    lng,
    lat,
    x: m0.x,
    y: m0.y,
    zPerM: m1.z,
    lo,
    d: [e1[0] - lo[0], e1[1] - lo[1], e1[2] - lo[2]],
  };
}

/** The first component of `a` that is not Object.is-equal to `b`'s, or null. */
function firstDiff(a: PBase, b: PBase): string | null {
  const pairs: [string, number, number][] = [
    ["lng", a.lng, b.lng],
    ["lat", a.lat, b.lat],
    ["x", a.x, b.x],
    ["y", a.y, b.y],
    ["zPerM", a.zPerM, b.zPerM],
  ];
  for (let i = 0; i < 3; i++) {
    pairs.push([`lo[${i}]`, a.lo[i], b.lo[i]], [`d[${i}]`, a.d[i], b.d[i]]);
  }
  for (const [name, p, q] of pairs) if (!Object.is(p, q)) return `${name}: ${p} vs ${q}`;
  if (a.lo.length !== 3 || a.d.length !== 3) return "a vector is not 3 long";
  return null;
}

function assertSame(points: [number, number][]) {
  for (const [lng, lat] of points) {
    const diff = firstDiff(baseOf(lng, lat), mapboxBaseOf(lng, lat));
    assert.equal(diff, null, `(${lng}, ${lat}) ${diff}`);
  }
}

// The spike's seeded LCG (spike-mesh/parity.ts, seed 12345), world then France.
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const world: [number, number][] = [];
for (let i = 0; i < 1000; i++) world.push([rnd() * 360 - 180, rnd() * 170 - 85]);
const france: [number, number][] = [];
for (let i = 0; i < 1000; i++) france.push([rnd() * 14 - 5, 41 + rnd() * 10]);

test("1,000 seeded world points: every component bit for bit", () => {
  assertSame(world);
});

test("1,000 seeded points over France: every component bit for bit", () => {
  assertSame(france);
});

test("the edges: equator, ±85.05, ±89.9, the poles, the antimeridian, -0", () => {
  const lats = [0, -0, 85.05, -85.05, 89.9, -89.9, 90, -90];
  const lngs = [0, -0, 180, -180, 2.35];
  const points: [number, number][] = [];
  for (const lat of lats) for (const lng of lngs) points.push([lng, lat]);
  assertSame(points);
});

test("Corsica, Réunion and an Antarctic ring vertex", () => {
  assertSame([
    [9.0, 42.0], // Corsica
    [8.538, 41.383],
    [55.536, -21.115], // Réunion
    [-180, -84.71338], // Antarctica's ring at the antimeridian
    [180, -90],
  ]);
});

test("NaN and a latitude past ±90 throw on both sides, with mapbox's message", () => {
  const cases: [number, number][] = [
    [NaN, 45],
    [2, NaN],
    [2, 90.0001],
    [2, -90.0001],
  ];
  for (const [lng, lat] of cases) {
    let want: unknown = null;
    try {
      mapboxBaseOf(lng, lat);
    } catch (e) {
      want = e;
    }
    assert.ok(want instanceof Error, `mapbox throws at (${lng}, ${lat})`);
    assert.throws(() => baseOf(lng, lat), { message: (want as Error).message });
  }
});
