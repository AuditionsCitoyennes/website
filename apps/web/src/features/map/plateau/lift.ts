// A plateau standing over flat ground (relief/groundSwitch.ts: "flat"): what
// is drawn above the ground, for the two things mapbox places on the ground —
// its markers and its pointer events. The lid's picture is the map seen at
// the lid's height; a pin left on the ground under it, or a click read on the
// ground under it, is off that picture by the lid's height seen at the
// camera's tilt (a few px on a fitted unit, more once zoomed in). So the pins
// of the raised unit are lifted to the lid, and a pointer over the lid reads
// the lid. On raised ground mapbox does both by itself: there is no lift.
//
// Pure: no mapbox import, no DOM — run with `node --import tsx --test` (root
// "test:scripts").

import { buildHitRings, hitTest, type HitRing } from "../lib/polygon";

/** What stands above flat ground. */
export interface PlateauLift {
  /** The lid's height, m (the plateau's height × WALL_OVERSHOOT). */
  altM: number;
  /** Whether a ground point is under the lid: inside the raised unit. */
  holds(lng: number, lat: number): boolean;
}

/** The lift of the raised features (`raised`: the plateau's outline, as given
 *  to its mesh) with a lid at `altM` metres. A point is held as it is or a
 *  world east or west of it: an outline may reach past ±180. */
export function liftOf(raised: readonly { geometry?: unknown }[], altM: number): PlateauLift {
  const rings: HitRing[] = [];
  for (const f of raised) if (f.geometry) rings.push(...buildHitRings(f.geometry));
  return {
    altM,
    holds: (lng, lat) =>
      hitTest(rings, lng, lat) || hitTest(rings, lng + 360, lat) || hitTest(rings, lng - 360, lat),
  };
}

/** A marker's altitude, m: the lid's for a point under it, 0 for any other
 *  (and for every point when nothing is lifted). */
export function altitudeAt(lift: PlateauLift | null, lng: number, lat: number): number {
  return lift && lift.holds(lng, lat) ? lift.altM : 0;
}

interface LngLat {
  lng: number;
  lat: number;
}

/** Where a pointer reads the map: the point of the lid under it when there is
 *  one (`lidPoint`: the pointer's ray met with the plane at `altM` metres,
 *  null when it cannot be had), else the ground's (`ground`, mapbox's own).
 *  With nothing lifted, the ground's, and the plane is not asked for. */
export function pointerLngLat<T extends LngLat>(
  lift: PlateauLift | null,
  ground: T,
  lidPoint: (altM: number) => LngLat | null,
): LngLat {
  if (!lift) return ground;
  const up = lidPoint(lift.altM);
  return up && lift.holds(up.lng, up.lat) ? up : ground;
}
