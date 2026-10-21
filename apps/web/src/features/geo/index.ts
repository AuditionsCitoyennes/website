// Administrative-level aggregation for the testimonies map — pure: no Vue, no
// Mapbox.
//
// Both navigation prototypes (explicit-scope drill-down and zoom-driven
// aggregation) read from ONE hierarchy built here: testimonies are rolled up by
// administrative unit (monde → pays → région → département → ville →
// arrondissement → lieu), each unit carrying a count, a weighted centroid, and
// a bounding box so the camera can frame it.

export { LEVELS, type Bounds, type GeoUnit, type LevelKey, type UnitGeo } from "./types";
export { centerInBounds, childrenBounds } from "./bounds";
export { ancestorsOf, buildGeoHierarchy, unitChainOf, unitsByLevelKey } from "./hierarchy";
export { applyBoundaries, depCodeOf, geometryContains } from "./boundaries";
export { levelKeyForZoom, scopeForView, SPAN_DESCEND, zoomCapForDepth } from "./scope";
export { abbrevCount, LEVEL_LABEL, levelLabelForDepth } from "./labels";
