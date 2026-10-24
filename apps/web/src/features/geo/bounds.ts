// Bounding boxes: the country's extent, a point's box, unions and centres.

import type { Bounds, GeoUnit } from "./types";

// Metropolitan France extent — used to frame + centre the country pin, since the
// current data covers only a corner and a data-derived centre would be far off.
export const METRO_FRANCE: Bounds = { minLat: 41.3, maxLat: 51.1, minLng: -5.2, maxLng: 9.6 };

// A small box, not a zero-area point, so a unit with a single location (and no
// fetched boundary polygon) still has a real extent — otherwise fitting it to the
// screen leaves its span at 0 and the viewport-containment scope could never enter
// it. ~0.012° ≈ 1.3 km. Real boundaries override this where available.
const POINT_PAD = 0.012;
export function pointBounds([lat, lng]: [number, number]): Bounds {
  return {
    minLat: lat - POINT_PAD,
    maxLat: lat + POINT_PAD,
    minLng: lng - POINT_PAD,
    maxLng: lng + POINT_PAD,
  };
}

export function unionBounds(list: Bounds[]): Bounds {
  return list.reduce((acc, b) => ({
    minLat: Math.min(acc.minLat, b.minLat),
    maxLat: Math.max(acc.maxLat, b.maxLat),
    minLng: Math.min(acc.minLng, b.minLng),
    maxLng: Math.max(acc.maxLng, b.maxLng),
  }));
}

// A macro pin sits at the centre of its area's bounding box — the geometric
// middle of where its children are — rather than a count-weighted centroid that
// would drag it toward the densest child. (A true administrative centroid needs
// real boundary geometry, which the prototype doesn't have yet.)
export function boundsCenter(b: Bounds): [number, number] {
  return [(b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2];
}

/** The extent of a unit's children (what its pins span) — for framing on drill.
 *  Differs from `unit.bounds` only for the country, whose bounds is the whole
 *  nation but whose children currently sit in one corner. */
export function childrenBounds(unit: GeoUnit): Bounds {
  if (!unit.children.length) return unit.bounds;
  return unionBounds(unit.children.map((c) => c.bounds));
}

/** Does a unit's centroid fall inside a viewport bounds (zoom-mode filtering)? */
export function centerInBounds(u: GeoUnit, b: Bounds): boolean {
  const [lat, lng] = u.center;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}
