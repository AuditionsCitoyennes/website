// What the "scope-outline" source should hold, and whether it has to be written
// (useScopeMask.applyOutline). Pure: no map, no Vue — table-tested.
//
// That source has one reader, the draped "scope-hover-fill" fallback, which
// only shows when no plateau stands. Every upload is a main-thread
// JSON.stringify of the whole outline, a worker parse + re-index, and a reload
// of every loaded tile, so the outline goes up only when that fallback can
// use it.

import type { OutlineFC } from "../types";

/**
 * The FeatureCollection the source should hold for `fc`: `fc` itself when the
 * draped fallback can show, `emptyFc` otherwise.
 *
 * A `kind === "scope"` feature means a plateau is coming (the predicate
 * ensurePlateau raises on), and so does a boundary still loading (`pending`):
 * the GL sweep owns the highlight then. An outline with no features at all
 * (the micropin zone hands the same shared empty collection every time) maps
 * to `emptyFc` too, so it dedupes against an empty source.
 */
export function outlineToUpload(
  fc: OutlineFC | null | undefined,
  pending: boolean,
  emptyFc: OutlineFC,
): OutlineFC {
  if (!fc || pending || !fc.features.length) return emptyFc;
  if (fc.features.some((f) => f.properties?.kind === "scope")) return emptyFc;
  return fc;
}

/**
 * The collection to write to the source, or null when it already holds it.
 * Identity, not content: it relies on the outline being a fresh object on every
 * recompute (useMapFeed) and never mutated in place.
 */
export function nextOutlineUpload(
  uploaded: OutlineFC,
  fc: OutlineFC | null | undefined,
  pending: boolean,
  emptyFc: OutlineFC,
): OutlineFC | null {
  const wanted = outlineToUpload(fc, pending, emptyFc);
  return wanted === uploaded ? null : wanted;
}
