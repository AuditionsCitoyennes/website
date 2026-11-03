// The world's frame (useCamera.flyToUnit). Pure: no Vue, type imports only.
//
// The root's bounds equal France's (union of children): fitting them verbatim
// makes the post-flight derive descend straight back into France (span ~0.8 ≥
// DESCEND) and needlessly churn its plateau. Inflated, France spans ~0.4 of
// the view and the world scope actually holds. A world of countries can leave
// the globe that way: wider than it shows (Antarctica's lieux with Russia's),
// or past mercator's latitudes (France with Madagascar), where mapbox refuses
// the fit (its LngLat stops at ±90) and a clamped fit lands on a pole. Then
// the globe, whole, around the box's middle.
import type { Bounds } from "@/features/geo";

/** The whole globe in sight, for a world no fit holds. */
export const WORLD_ZOOM = 1.5;
/** A fit's box stays inside these latitudes (mercator's, about). */
const FIT_LAT = 85;
/** The eased centre's latitude is taken inside this band. */
const CENTRE_LAT = 60;

export type WorldFrame =
  { type: "fit"; bounds: Bounds } | { type: "ease"; center: [number, number]; zoom: number };

export function worldFrame(b: Bounds): WorldFrame {
  const padLat = (b.maxLat - b.minLat) * 0.6;
  const padLng = (b.maxLng - b.minLng) * 0.6;
  const bounds = {
    minLat: b.minLat - padLat,
    maxLat: b.maxLat + padLat,
    minLng: b.minLng - padLng,
    maxLng: b.maxLng + padLng,
  };
  if (bounds.maxLng - bounds.minLng <= 180 && bounds.maxLat <= FIT_LAT && bounds.minLat >= -FIT_LAT)
    return { type: "fit", bounds };
  const lat = (Math.max(-CENTRE_LAT, bounds.minLat) + Math.min(CENTRE_LAT, bounds.maxLat)) / 2;
  return { type: "ease", center: [lat, (b.minLng + b.maxLng) / 2], zoom: WORLD_ZOOM };
}
