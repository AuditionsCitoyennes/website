// The Mapbox engine: the one map component, the types GeoNav drives it with
// and the events it shares with the stage above it. The pure maths has its own
// entry (./lib) and the types theirs (./types), for what must not pull the
// component.
export { default as GeoDrillMap } from "./GeoDrillMap.vue";
export * from "./types";
export * from "./events";
// The plateau lid's DEV switch (the Témoignages page draws it).
export { lidMode, setLidMode, type LidMode } from "./plateau/lidSwitch";
export { lidCheck, setLidCheck, type LidCheck } from "./plateau/lidSwitch";
// Whether the lid pictures are kept for a unit selected again: its DEV switch
// (the Témoignages page draws it).
export { lidCacheMode, setLidCacheMode, type LidCacheMode } from "./plateau/lidCacheSwitch";
// The plateau mesh's DEV switch (the Témoignages page draws it).
export { meshMode, setMeshMode, type MeshMode } from "./plateau/meshSwitch";
// How the plateau's DEM tiles are prefetched: its DEV switch (the Témoignages page draws it).
export { reliefPrefetch, setReliefPrefetch, type ReliefPrefetch } from "./relief/reliefSwitch";
// When the map's two workers start: its DEV switch (the Témoignages page draws it).
export { bootWorkers, setBootWorkers, BOOT_WORKERS, type BootWorkers } from "./bootWorkersSwitch";
// Where the labels' letters come from: its DEV switch (the Témoignages page draws it).
export { glyphs, setGlyphs, GLYPHS, type Glyphs } from "./glyphSwitch";
// What the map's box shows when the map cannot start: its DEV switch (the Témoignages page draws it).
export { mapFallback, setMapFallback, MAP_FALLBACKS, type MapFallback } from "./fallbackSwitch";
// How a tap on a territory is answered while its plateau is on its way: its
// DEV switches (the Témoignages page draws them) and what GeoNav reads of them.
export {
  setTapAnswerMode,
  setTapEndMode,
  setTapFastMode,
  setTapFrameMode,
  setTapLineColor,
  setTapStepsMode,
  tapAnswerMode,
  tapEndMode,
  tapFastMode,
  tapFrameMode,
  tapLineColor,
  tapMarkFor,
  tapStepsMode,
  type TapAnswerMode,
  type TapEndMode,
  type TapFastMode,
  type TapFrameMode,
  type TapLineColor,
  type TapMark,
  type TapStepsMode,
} from "./plateau/tapAnswerSwitch";
// A real step of a tapped unit's data (GeoNav reports its outline file's).
export type { TapStep } from "./plateau/tapProgress";
// What a late outline file does to the map: its DEV switch (the Témoignages
// page draws it; geo-nav's outline files and the map's outline watcher read it).
export {
  LATE_CAP_MS,
  lateFilesMode,
  setLateFilesMode,
  type LateFilesMode,
} from "./plateau/lateFilesSwitch";
// The cold tap (a unit chosen before its own outline is in memory): its three
// DEV switches (the Témoignages page draws them; geo-nav's outline files and
// the plateau read them).
export {
  coldStartMode,
  outlineWait,
  outlineWaitFor,
  regionSelfMode,
  SELF_GRACE_MS,
  setColdStartMode,
  setOutlineWait,
  setRegionSelfMode,
  setTapLinesMode,
  tapLinesMode,
  tapLinesWaitFor,
  type ColdStartMode,
  type OutlineWait,
  type RegionSelfMode,
  type TapLinesMode,
} from "./plateau/coldTapSwitch";
// What the plateau stands on, raised ground or flat: its DEV switch (the Témoignages page draws it).
export { reliefGround, setReliefGround, type ReliefGround } from "./relief/groundSwitch";
// What the map does where the graphics are slow, and whether it times its first flight: their DEV switches (the Témoignages page draws them).
export { msaaChoice, setMsaaChoice, type MsaaChoice } from "./graphicsSwitch";
export { dprChoice, setDprChoice, type DprChoice } from "./graphicsSwitch";
export { frameMeasure, setFrameMeasure, type FrameMeasure } from "./graphicsSwitch";
// Where the map's work runs during a selection, on the page's thread or off it: their DEV switches (the Témoignages page draws them).
export { linesMesh, setLinesMesh, type LinesMesh } from "./threadSwitch";
export { globeLate, setGlobeLate, type GlobeLate } from "./threadSwitch";
export { tintCut, setTintCut, type TintCut } from "./threadSwitch";
export { pinsRebuild, setPinsRebuild, type PinsRebuild } from "./threadSwitch";
// When the lid's hidden map is created, and whether there is one: its DEV switch (the Témoignages page draws it).
export { lidMap, setLidMap, type LidMap } from "./plateau/lidMapSwitch";
export { lineMesh, setLineMesh, type LineMesh } from "./plateau/lineMeshSwitch";
// How the ground rises under the plateau and when the rise starts: their DEV switches (the Témoignages page draws them).
export { riseMode, setRiseMode, type RiseMode } from "./plateau/riseSwitch";
export { riseOrder, setRiseOrder, type RiseOrder } from "./plateau/riseSwitch";
// Whether the standing plateau wears its halo: its DEV switch (the Témoignages page draws it).
export { boundaryHalo, setBoundaryHalo, type BoundaryHalo } from "./plateau/haloSwitch";
// How much the map keeps in memory of the places already seen: its DEV switch (the Témoignages page draws it).
export { mapCaches, setMapCaches, type MapCaches } from "./cacheBudget";
