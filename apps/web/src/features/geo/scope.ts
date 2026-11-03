// Which unit the map shows: read off the viewport (the unified scope).

import type { Bounds, GeoUnit } from "./types";
import { lngNear } from "./wrap";

// ---- Unified scope derivation (map viewport → current scope) ----
// The scope is read off the map, not chosen by click: we walk the hierarchy from
// the root, descending into the child the viewport sits inside, and the panel
// shows that scope's children + a breadcrumb to climb back out. A child becomes the
// scope once its bbox fills enough of the visible viewport (span ratio), so a click
// (which fits the unit's bounds to the screen) and free pan/zoom resolve to the
// SAME scope — no fixed zoom bands.

// How much of the viewport a unit's bbox spans on its dominant axis (1 = fills it).
function spanRatio(child: Bounds, view: Bounds): number {
  const vLng = view.maxLng - view.minLng;
  const vLat = view.maxLat - view.minLat;
  if (vLng <= 0 || vLat <= 0) return Infinity; // degenerate view → treat as "fills"
  return Math.max((child.maxLng - child.minLng) / vLng, (child.maxLat - child.minLat) / vLat);
}

// Enter a NEW child once it fills 60% of the view; release it below 50%. The small
// gap is hysteresis (no flicker right at the boundary) kept NARROW so zooming back
// out returns to the parent at nearly the same zoom where you entered — a wide band
// read as "it takes more unzoom to leave than zoom to enter". After fitBounds(unit)
// the unit spans ~0.8 of the view, comfortably clearing DESCEND.
export const SPAN_DESCEND = 0.6;
const SPAN_ASCEND = 0.5;
// A sibling taking over the branch (a pan across a border) only has to be a
// fair part of the view: the depth does not change. Since the view's height
// counts the ground the tilt shows, a smaller neighbour (Centre-Val de Loire
// from Nouvelle-Aquitaine) measures under 0.5 there, and at ASCEND's 0.5 the
// walk surfaced all of France instead.
const SPAN_LATERAL = 0.35;

function boundsHas(b: Bounds, lat: number, lng: number): boolean {
  const x = lngNear(lng, b); // a box past ±180 (wrap.ts)
  return lat >= b.minLat && lat <= b.maxLat && x >= b.minLng && x <= b.maxLng;
}

function dist2(a: [number, number], b: [number, number]): number {
  const dlat = a[0] - b[0];
  const dlng = a[1] - b[1];
  return dlat * dlat + dlng * dlng;
}

/** The unit the viewport is currently "inside", walked from the root. At each level
 *  pick the child the view centre sits in and descend while it fills the view past
 *  the threshold. `prefer` (the previous scope's ancestor chain, self included)
 *  provides HYSTERESIS in both axes: vertically, preferred units hold with the
 *  lower ASCEND threshold; horizontally, the incumbent branch is KEPT while it
 *  still contains the centre — without this, mid-gesture derivations flap between
 *  overlapping siblings (bbox overlaps, or commune polygons not yet loaded) and
 *  each flap sinks/resurrects the plateau ("down, up again, down"). Only a
 *  candidate that provably (polygon) contains the centre while the incumbent does
 *  NOT can take the branch over. `contains` tests real polygon containment. */
export function scopeForView(
  root: GeoUnit,
  view: Bounds,
  prefer?: Set<string>,
  contains?: (unit: GeoUnit, lat: number, lng: number) => boolean,
): GeoUnit {
  const lat = (view.minLat + view.maxLat) / 2;
  const lng = (view.minLng + view.maxLng) / 2;
  let node = root;
  for (;;) {
    // Its children are not known yet: nothing to descend into (useUnitTree).
    if (node.childrenPending) break;
    const kids = node.children.filter((c) => c.levelKey !== "place");
    if (!kids.length) break;
    // Children whose POLYGON provably contains the centre (when geometry is
    // available), and those whose bbox covers it — the polygon's holders
    // included: a unit can hold a point past its own box (a département holds
    // its communes, whose contours can run past its france-geojson box).
    const insidePoly = contains ? kids.filter((c) => contains(c, lat, lng)) : [];
    const insideBox = kids.filter((c) => boundsHas(c.bounds, lat, lng) || insidePoly.includes(c));
    const incumbent = insideBox.find((c) => prefer?.has(c.id));
    let cand: GeoUnit;
    if (incumbent && (!insidePoly.length || insidePoly.some((c) => c.id === incumbent.id))) {
      cand = incumbent; // sticky: the current branch still holds the centre
    } else {
      const pool = insidePoly.length ? insidePoly : insideBox.length ? insideBox : kids;
      cand = pool.reduce((a, b) =>
        dist2(a.center, [lat, lng]) <= dist2(b.center, [lat, lng]) ? a : b,
      );
    }
    // Hysteresis resists changing DEPTH, not changing SIBLING. If the incumbent
    // branch already runs through this level, adopting a different child here is
    // a LATERAL move (panning from one région to its neighbour), so it keeps the
    // lenient ASCEND threshold. Charging it the stricter DESCEND toll made the
    // walk break as soon as the centre left the current unit — surfacing the
    // PARENT (all of France) instead of the neighbouring région under the centre.
    const lateral = kids.some((c) => prefer?.has(c.id));
    const threshold = prefer?.has(cand.id) ? SPAN_ASCEND : lateral ? SPAN_LATERAL : SPAN_DESCEND;
    if (spanRatio(cand.bounds, view) < threshold) break;
    node = cand;
  }
  return node;
}
