// Administrative-level aggregation for the testimonies map — pure: no Vue, no
// Mapbox.
//
// Both navigation prototypes (explicit-scope drill-down and zoom-driven
// aggregation) read from ONE hierarchy built here: testimonies are rolled up by
// administrative unit (monde → pays → région → département → ville →
// arrondissement → lieu), each unit carrying a count, a weighted centroid, and
// a bounding box so the camera can frame it.

export {
  LEVELS,
  type Bounds,
  type GeoLevel,
  type GeoRef,
  type GeoUnit,
  type HeightClass,
  type LevelKey,
  type UnitGeo,
} from "./types";
export { centerInBounds } from "./bounds";
export {
  ancestorsOf,
  buildGeoHierarchy,
  placeLabel,
  unitChainOf,
  unitsByLevelKey,
} from "./hierarchy";
export {
  buildTreeFromUnits,
  byServerOrder,
  WORLD,
  type ServerOrdered,
  type UnitTreeData,
  type UnitTreeEntry,
} from "./treeFromUnits";
export {
  applyBoundaries,
  communeCodeOf,
  depCodeOf,
  featureFor,
  geometryContains,
  isFrench,
  outlineSourceOf,
  type BoundaryLookups,
  type LevelLookup,
  type OutlineSource,
} from "./boundaries";
export { scopeForView, SPAN_DESCEND } from "./scope";
export { abbrevCount } from "./labels";
