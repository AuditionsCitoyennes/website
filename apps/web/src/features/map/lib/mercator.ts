// A boundary vertex's two projections (PBase: its only home), in closed form:
// mapbox-gl's own MercatorCoordinate.fromLngLat and LngLat.toEcef, replayed
// operation for operation (mapbox-gl 3.34's dist: mercatorXfromLng,
// mercatorYfromLat, mercatorZfromAltitude, LngLat.toEcef, csLatLngToECEF), so
// every component comes out bit for bit as mapbox's (lib/mercator.test.ts
// checks it against the live library) and no mapbox object is made per
// vertex. Pure, no import: the plateau's mesh can be built where neither
// mapbox-gl nor the page is (a worker).
//
// These are mapbox's constants (its earth radius, 6 371 008.8 m, and its globe
// of EXTENT / 2π), deliberately separate from the slabs' web-mercator
// measures (slabs/constants.ts: mercX, mercY, R = 6 378 137 m): the plateau
// must stand exactly where mapbox draws.

const EARTH_RADIUS = 6371008.8;
const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
const GLOBE_RADIUS = 8192 / Math.PI / 2;
const DEG_TO_RAD = Math.PI / 180;
/** toEcef's radius at 0 and 1 m: GLOBE_RADIUS + altitude × GLOBE_RADIUS / R. */
const ECEF_R0 = GLOBE_RADIUS + (0 * GLOBE_RADIUS) / EARTH_RADIUS;
const ECEF_R1 = GLOBE_RADIUS + (1 * GLOBE_RADIUS) / EARTH_RADIUS;

// ---- Per-geometry projection caches' unit (lib/projection.ts) ---------------
// Both projections are LINEAR in altitude (merc z = alt·zPerM; ecef(alt) =
// ecef(0) + alt·d), so a vertex is projected once and any height is a
// multiply-add at assembly time.
export interface PBase {
  lng: number;
  lat: number;
  x: number; // mercator at ground
  y: number;
  zPerM: number; // mercator z per metre of altitude
  lo: [number, number, number]; // ecef at ground
  d: [number, number, number]; // ecef delta per metre of altitude
}

/**
 * The vertex at (lng, lat), as mapbox projects it. Throws where mapbox's
 * LngLat does (NaN, a latitude past ±90), with its messages. `d` is
 * deliberately the difference toEcef(1) − toEcef(0), cancellation noise and
 * all, not the radial unit × r / R it equals in exact arithmetic: the rim
 * (which packs it, projection.ts) and the globe set keep mapbox's bytes.
 */
export function baseOf(lng: number, lat: number): PBase {
  // LngLat's constructor.
  if (isNaN(lng) || isNaN(lat)) {
    throw new Error(`Invalid LngLat object: (${lng}, ${lat})`);
  }
  if (lat > 90 || lat < -90) {
    throw new Error("Invalid LngLat latitude value: must be between -90 and 90");
  }
  // MercatorCoordinate.fromLngLat at 0 and 1 m: x, y, and z per metre.
  const x = (180 + lng) / 360;
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  const zPerM = 1 / (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180));
  // LngLat.toEcef at 0 and 1 m, left to right as csLatLngToECEF has it (each
  // sine and cosine taken once: the same values, no closure, no extra array).
  const cosLat = Math.cos(lat * DEG_TO_RAD);
  const sinLat = Math.sin(lat * DEG_TO_RAD);
  const lngR = lng * DEG_TO_RAD;
  const sinLng = Math.sin(lngR);
  const cosLng = Math.cos(lngR);
  const lo: [number, number, number] = [
    cosLat * sinLng * ECEF_R0,
    -sinLat * ECEF_R0,
    cosLat * cosLng * ECEF_R0,
  ];
  return {
    lng,
    lat,
    x,
    y,
    zPerM,
    lo,
    d: [
      cosLat * sinLng * ECEF_R1 - lo[0],
      -sinLat * ECEF_R1 - lo[1],
      cosLat * cosLng * ECEF_R1 - lo[2],
    ],
  };
}
