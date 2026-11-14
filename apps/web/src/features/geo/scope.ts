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

// ---- The hold: a selected zone survives a pan ----
// The walk below keeps a branch while its box holds the view's CENTRE. On a
// wide screen that is a long way: a unit framed by a click spans about 0.8 of
// the view, the centre leaves its box after a pan of 0.4 of the view's width.
// On a 360 px phone the view is 288 px wide, so that is 115 px of thumb: the
// zone just tapped, half of it still on screen, was replaced by whichever
// neighbour's box held the centre (France by Portugal), and its plateau sank
// under the finger. So the zone a selection HOLDS (useScope: the scope the
// camera was last sent to, while it is the scope) is kept wherever the centre
// is, as long as it is meaningfully in view. Two tests, on boxes, either is
// enough:
// - a fair share of the ZONE's box is in the view (a zone smaller than the
//   screen, pushed toward an edge);
// - the zone's box covers a fair share of the VIEW (a zone larger than the
//   screen: little of it is ever in view, yet it is most of what is seen).
// Depth is not held: zooming out past the zone (SPAN_ASCEND) or in onto one of
// its children (SPAN_DESCEND) changes the scope exactly as without a hold, and
// so does a pan that takes the zone out of view.

/** A held zone is kept while at least this share of its box is in the view… */
export const KEEP_ZONE_SHARE = 0.1;
/** …or while its box covers at least this share of the view. */
export const KEEP_VIEW_SHARE = 0.1;

/** How much of `zone`'s box lies in `view` (0…1), and how much of `view` it
 *  covers (0…1). A box past ±180 (wrap.ts) is met by the view's nearest copy.
 *  A zone with no width or no height (one point) counts along its other axis. */
export function inViewShares(zone: Bounds, view: Bounds): { zone: number; view: number } {
  const vw = view.maxLng - view.minLng;
  const vh = view.maxLat - view.minLat;
  if (!(vw > 0) || !(vh > 0)) return { zone: 0, view: 0 };
  const shift =
    360 * Math.round(((zone.minLng + zone.maxLng) / 2 - (view.minLng + view.maxLng) / 2) / 360);
  const zw = zone.maxLng - zone.minLng;
  const zh = zone.maxLat - zone.minLat;
  const ox =
    Math.min(view.maxLng + shift, zone.maxLng) - Math.max(view.minLng + shift, zone.minLng);
  const oy = Math.min(view.maxLat, zone.maxLat) - Math.max(view.minLat, zone.minLat);
  if (ox < 0 || oy < 0) return { zone: 0, view: 0 };
  const along = (overlap: number, size: number) => (size > 0 ? overlap / size : 1);
  return { zone: along(ox, zw) * along(oy, zh), view: (ox * oy) / (vw * vh) };
}

/** A held zone is still meaningfully in view: enough of it is in sight, or it
 *  is enough of what is in sight. */
export function keptInView(zone: Bounds, view: Bounds): boolean {
  const share = inViewShares(zone, view);
  return share.zone >= KEEP_ZONE_SHARE || share.view >= KEEP_VIEW_SHARE;
}

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
 *  NOT can take the branch over. `contains` tests real polygon containment.
 *  `hold` is the zone a selection holds (see "The hold" above): while it is
 *  meaningfully in view, the branch down to it stays the incumbent wherever
 *  the centre is. The thresholds are unchanged, so depth still follows the view. */
export function scopeForView(
  root: GeoUnit,
  view: Bounds,
  prefer?: Set<string>,
  contains?: (unit: GeoUnit, lat: number, lng: number) => boolean,
  hold?: GeoUnit | null,
): GeoUnit {
  const lat = (view.minLat + view.maxLat) / 2;
  const lng = (view.minLng + view.maxLng) / 2;
  // The held zone's branch (its ancestors and itself), when it is in view.
  const held = hold && keptInView(hold.bounds, view) ? new Set([...hold.ancestors, hold.id]) : null;
  let node = root;
  for (;;) {
    // Its children are not known yet: nothing to descend into (useUnitTree).
    if (node.childrenPending) break;
    const kids = node.children.filter((c) => c.levelKey !== "place");
    if (!kids.length) break;
    // Children whose POLYGON provably contains the centre (when geometry is
    // available), and those whose bbox covers it — the polygon's holders
    // included: a unit can hold a point past its own box (a département holds
    // its communes, whose contours can run past its box).
    const insidePoly = contains ? kids.filter((c) => contains(c, lat, lng)) : [];
    const insideBox = kids.filter((c) => boundsHas(c.bounds, lat, lng) || insidePoly.includes(c));
    const kept = held ? kids.find((c) => held.has(c.id)) : undefined;
    const incumbent = insideBox.find((c) => prefer?.has(c.id));
    let cand: GeoUnit;
    if (kept) {
      cand = kept; // held: the selected zone is still in view
    } else if (incumbent && (!insidePoly.length || insidePoly.some((c) => c.id === incumbent.id))) {
      cand = incumbent; // sticky: the current branch still holds the centre
    } else {
      // Under a held zone the centre can be outside it: none of its children
      // is "the nearest one" then, only one that holds the centre is entered.
      if (held && node.id === hold?.id && !insideBox.length && !boundsHas(node.bounds, lat, lng))
        break;
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
