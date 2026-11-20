// How the home page's map card opens into the map page (map-stage/MapStage.vue):
// on a device of the tier "full", the card grows into the page over 0.65 s —
// each frame of the growth resizes the map's drawing surface, frames the map
// again and draws it at once, on top of Mapbox's own frame; on a weak one
// (the tier "light" or "minimal", shared/device/deviceTier.ts), and for a
// visitor who asked the system for reduced motion, the page appears at once:
// one resize, one framing. On a weak device the card is a still picture by
// default anyway (features/home/homeMapPolicy.ts), so this matters there only
// when the live card was chosen. The tier is read at each opening.
//
// Pure: loadable under node (cardOpenSwitch.test.ts).

import type { DeviceTier } from "./deviceTier";

/** Whether the card grows into the page, for a device tier and the system's
 *  reduced-motion setting. */
export function cardGrows(tier: DeviceTier, reducedMotion: boolean): boolean {
  return !reducedMotion && tier === "full";
}
