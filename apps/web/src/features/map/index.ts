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
