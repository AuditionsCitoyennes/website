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
  serverChainOf,
  WORLD,
  type LieuStub,
  type ServerOrdered,
  type UnitTreeData,
  type UnitTreeEntry,
} from "./treeFromUnits";
export { applyBoundaries, communeCodeOf, geometryContains } from "./boundaries";
export {
  holdInView,
  inViewShares,
  KEEP_VIEW_SHARE,
  KEEP_ZONE_SHARE,
  scopeForView,
  SPAN_DESCEND,
} from "./scope";
export { abbrevCount } from "./labels";
export {
  checkResponse,
  fileKey,
  fileUrl,
  isReleaseSkew,
  keyOf,
  OutlineStore,
  rootUrl,
  validateBody,
  type FileEntryV1,
  type FileSelfV1,
  type GFileV1,
  type KFileV1,
  type OutlineFileV1,
  type OutlineGeometry,
  type OutlineKind,
  type OutlineRow,
  type RootRowV1,
  type RootV1,
  type UFileV1,
} from "./outlines";
export {
  OUTLINE_WAIT_MS,
  OutlineLoader,
  type OutlineReady,
  type OutlineStatus,
} from "./outlineLoader";
export {
  countryOutline,
  globeBatch,
  prefetchKind,
  rowKnownAbsent,
  selfAheadOf,
  selfFileOf,
  siblingSelves,
  type RoleRow,
} from "./outlineRoles";
export { boxesMeet, canonicalCopies, lngNear, type WrapGeometry } from "./wrap";
