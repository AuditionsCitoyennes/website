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
// two DEV switches (the Témoignages page draws them) and what GeoNav reads of them.
export {
  setTapAnswerMode,
  setTapFrameMode,
  tapAnswerMode,
  tapFrameMode,
  tapIsTouch,
  tapMarkFor,
  type TapAnswerMode,
  type TapFrameMode,
  type TapMark,
} from "./plateau/tapAnswerSwitch";
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
  type ColdStartMode,
  type OutlineWait,
  type RegionSelfMode,
} from "./plateau/coldTapSwitch";
