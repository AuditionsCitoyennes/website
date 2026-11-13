// A plateau over flat ground (lift.ts): which points are under the lid, the
// altitude a marker is given, and where a pointer reads the map. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { altitudeAt, liftOf, pointerLngLat } from "./lift";

const square = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
/** A unit of two parts, the first with a hole. */
const UNIT = [
  {
    geometry: {
      type: "MultiPolygon",
      coordinates: [[square(0, 0, 10, 10), square(4, 4, 6, 6)], [square(20, 0, 22, 2)]],
    },
  },
];

test("liftOf: a point inside the raised unit is held, a hole and the outside are not", () => {
  const lift = liftOf(UNIT, 127.5);
  assert.equal(lift.altM, 127.5);
  assert.equal(lift.holds(2, 2), true);
  assert.equal(lift.holds(21, 1), true);
  assert.equal(lift.holds(5, 5), false); // the hole
  assert.equal(lift.holds(15, 1), false); // between the parts
  assert.equal(lift.holds(-1, 5), false);
  assert.equal(lift.holds(5, 11), false);
});

test("liftOf: several features, and none", () => {
  const two = liftOf(
    [
      { geometry: { type: "Polygon", coordinates: [square(0, 0, 1, 1)] } },
      { geometry: { type: "Polygon", coordinates: [square(5, 5, 6, 6)] } },
    ],
    10,
  );
  assert.equal(two.holds(0.5, 0.5), true);
  assert.equal(two.holds(5.5, 5.5), true);
  assert.equal(two.holds(3, 3), false);
  const none = liftOf([], 10);
  assert.equal(none.holds(0, 0), false);
  // A feature without a geometry holds nothing and breaks nothing.
  assert.equal(liftOf([{}], 10).holds(0, 0), false);
});

test("liftOf: an outline past ±180 holds a point given a world east or west of it", () => {
  // Drawn from 170 to 190: its east part is at −175 for a pin, 185 for the outline.
  const lift = liftOf(
    [{ geometry: { type: "Polygon", coordinates: [square(170, -5, 190, 5)] } }],
    50,
  );
  assert.equal(lift.holds(185, 0), true);
  assert.equal(lift.holds(-175, 0), true);
  assert.equal(lift.holds(175, 0), true);
  assert.equal(lift.holds(-165, 0), false);
  // …and one drawn below −180.
  const west = liftOf(
    [{ geometry: { type: "Polygon", coordinates: [square(-190, -5, -170, 5)] } }],
    50,
  );
  assert.equal(west.holds(175, 0), true);
  assert.equal(west.holds(-175, 0), true);
  assert.equal(west.holds(165, 0), false);
});

test("altitudeAt: the lid's height under the lid, 0 elsewhere and with nothing lifted", () => {
  const lift = liftOf(UNIT, 63.75);
  assert.equal(altitudeAt(lift, 2, 2), 63.75);
  assert.equal(altitudeAt(lift, 5, 5), 0);
  assert.equal(altitudeAt(lift, 30, 30), 0);
  assert.equal(altitudeAt(null, 2, 2), 0);
});

test("pointerLngLat: the lid's point over the lid, the ground's anywhere else", () => {
  const lift = liftOf(UNIT, 100);
  const ground = { lng: 2.4, lat: 2.6 };
  // Over the lid: the plane's point, asked at the lid's height.
  let asked: number[] = [];
  const onLid = pointerLngLat(lift, ground, (altM) => {
    asked.push(altM);
    return { lng: 2, lat: 2 };
  });
  assert.deepEqual(onLid, { lng: 2, lat: 2 });
  assert.deepEqual(asked, [100]);
  // The plane's point outside the unit (the pointer is on the wall, or beside
  // the plateau): the ground's, the very object mapbox gave.
  assert.equal(
    pointerLngLat(lift, ground, () => ({ lng: -1, lat: 2 })),
    ground,
  );
  // In the hole: the ground's.
  assert.equal(
    pointerLngLat(lift, ground, () => ({ lng: 5, lat: 5 })),
    ground,
  );
  // No plane to be had: the ground's.
  assert.equal(
    pointerLngLat(lift, ground, () => null),
    ground,
  );
  // Nothing lifted (raised ground, or no plateau): the ground's, the plane not asked for.
  asked = [];
  assert.equal(
    pointerLngLat(null, ground, (altM) => {
      asked.push(altM);
      return { lng: 2, lat: 2 };
    }),
    ground,
  );
  assert.deepEqual(asked, []);
});
