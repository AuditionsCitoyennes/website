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
// Where the plateau's relief is rendered: its DEV switch (the Témoignages page draws it).
export { reliefPrefetch, setReliefPrefetch, type ReliefPrefetch } from "./relief/reliefSwitch";
