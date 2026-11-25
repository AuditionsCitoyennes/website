// The Mapbox engine: the one map component, the types GeoNav drives it with
// and the events it shares with the stage above it. The pure maths has its own
// entry (./lib) and the types theirs (./types), for what must not pull the
// component.
export { default as GeoDrillMap } from "./GeoDrillMap.vue";
export * from "./types";
export * from "./events";
// What a tap on a territory is answered with while its plateau is on its way.
export { TAP_MARK, type TapMark } from "./plateau/tapAnswerSwitch";
// A real step of a tapped unit's data (GeoNav reports its outline file's).
export type { TapStep } from "./plateau/tapProgress";
// The outline files' waits (geo-nav's outline files and the plateau read them).
export { LATE_CAP_MS } from "./plateau/lateFilesSwitch";
export { outlineWaitFor, SELF_GRACE_MS, tapLinesWaitFor } from "./plateau/coldTapSwitch";
// What the map does where the graphics are slow, and whether it times its first flight: their DEV switches (the Témoignages page draws them).
export { dprChoice, setDprChoice, type DprChoice } from "./graphicsSwitch";
export { frameMeasure, setFrameMeasure, type FrameMeasure } from "./graphicsSwitch";
