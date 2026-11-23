// Who started a gesture that moves the map, read off the DOM event behind
// mapbox's `movestart` (useMapCamera.onMoveStart, GeoDrillMap's
// `userGesture`): the keys on a focused map (a `keydown`), the map's own zoom
// buttons (their `click`, its target inside a `.mapboxgl-ctrl`), or a hand
// (a finger, the mouse, a double-tap or double-click, the wheel).
//
// No import but a type, nothing run at load, no DOM global read (the target
// is asked for `closest` if it has one): loadable under node
// (gestureSource.test.ts).
import type { MapGestureSource } from "../types";

/** The DOM event a `movestart` carries, as far as this reads it. */
export interface GestureEventLike {
  type: string;
  target?: unknown;
}

/** Who started the gesture `oe` began. */
export function gestureSourceOf(oe: GestureEventLike): MapGestureSource {
  if (/^key/.test(oe.type)) return "keys";
  const t = oe.target as { closest?: (sel: string) => unknown } | null | undefined;
  if (t && typeof t.closest === "function" && t.closest(".mapboxgl-ctrl")) return "controls";
  return "hand";
}
