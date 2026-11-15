// The map's pure maths — its own entry, so the analyses (which size their
// slabs with it) never pull the component. Named export by export: the six
// modules under slabs/ share helpers of their own (the earth's measures, the
// spaces a slab is laid out in) that are not the entry's. With it, the
// still-map scheduler (stillMap.ts): work that waits for the map to be at rest.
export { whenMapStill, type StillJobOptions } from "./stillMap";
export {
  FIT_PITCH_DEG,
  FRAME_FILL,
  TEXT_SCALE,
  latOf,
  lngOf,
  mercX,
  mercY,
  smoothstep,
  type SlabSpace,
} from "./slabs/constants";
export { slabProjector, type SlabCam, type SlabProjector } from "./slabs/slabCamera";
export { fitSilhouette, type FitOpts, type FitShape } from "./slabs/fitSilhouette";
export {
  SLAB_SAFETY,
  SLAB_SAFETY_FLAT,
  solveSlabScales,
  type Bbox,
  type SlabBoxPx,
  type SlabScale,
  type SlabScales,
  type SolveOpts,
} from "./slabs/slabScales";
export {
  SLAB_RADIUS_PX,
  pieceOutline,
  pieceRadius,
  ringSectorArcs,
  slabPointAt,
  slabPointPx,
  slabRects,
  type PieceBox,
  type SlabRect,
} from "./slabs/slabRects";
export {
  applyHomography,
  homography,
  isConvexQuad,
  matrix3dOf,
  unapplyHomography,
} from "./slabs/homography";
