// Whether the site's glass (the panel, the bottom sheet, the header, the
// card's button over the map, the analyses' plates, the dialogs' veil) blurs
// what is behind it: on a device of the tier "full", as the stylesheet asks
// (`backdrop-filter`, and its `-webkit-` twin for Safari before 18); on a weak
// one (the tier "light" or "minimal", shared/device/deviceTier.ts) each glass
// shows what is behind it, sharp, through its own colour (a little more
// opaque, html[data-glass="plein"] in shared/styles/utilities.css): a blur is
// drawn again each frame the map moves behind it.
//
// Read once per page load, at boot (main.ts), from the tier known then: the
// browser's hints, a step kept from an earlier visit's measure, or the forced
// tier. A step measured during this visit, or a software renderer first seen
// by the map, takes effect at the next page load.
//
// Pure: loadable under node (glassSwitch.test.ts).

import type { DeviceTier } from "./deviceTier";

/** Whether the glass blurs on a device of this tier. */
export function glassBlurs(tier: DeviceTier): boolean {
  return tier === "full";
}

/** The value of <html data-glass> for a tier: "plein" when the glass does
 *  not blur, null (no attribute) when it does. */
export function glassAttribute(tier: DeviceTier): "plein" | null {
  return glassBlurs(tier) ? null : "plein";
}
