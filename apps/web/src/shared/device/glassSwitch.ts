// Whether the site's glass (the panel, the bottom sheet, the header, the
// card's button over the map, the analyses' plates, the dialogs' veil) blurs
// what is behind it, compared live in the builds with the testing tools (the
// dev server and staging, __TEST_TOOLS__), kept in localStorage like the
// labels' font (map/glyphSwitch.ts) and drawn as the DEV dialog's « Verre »
// row:
//
// - "flou": every device blurs, as the stylesheet asks (`backdrop-filter`,
//   and its `-webkit-` twin for Safari before 18).
// - "plein": no device blurs: each glass shows what is behind it, sharp,
//   through its own colour (a little more opaque, html[data-glass="plein"]
//   in shared/styles/utilities.css). Chrome, Edge and Firefox drew the site
//   this way while the built stylesheet carried the `-webkit-` form alone.
// - "auto" (the default): "flou" on a device of the tier "full", "plein" on
//   a weak one (the tier "light" or "minimal", shared/device/deviceTier.ts):
//   a blur is drawn again each frame the map moves behind it.
//
// Read once per page load, at boot (main.ts), from the tier known then: the
// browser's hints, a step kept from an earlier visit's measure, or the forced
// tier. A step measured during this visit, or a software renderer first seen
// by the map, takes effect at the next page load. Switching reloads the page.
// Production has neither key nor switch: DEFAULT_GLASS, so "auto".
//
// Pure: loadable under node (glassSwitch.test.ts).

import type { DeviceTier } from "./deviceTier";

export type Glass = "auto" | "flou" | "plein";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_GLASS: Glass = "auto";

export const GLASSES: readonly Glass[] = ["auto", "flou", "plein"];

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedGlass(): Glass {
  try {
    const raw = localStorage.getItem("ac:glass");
    return (GLASSES as readonly string[]).includes(raw ?? "") ? (raw as Glass) : DEFAULT_GLASS;
  } catch {
    return DEFAULT_GLASS;
  }
}

/** This page load's mode. */
export const glass: Glass = __TEST_TOOLS__ ? storedGlass() : DEFAULT_GLASS;

/** Another mode: kept, and the page loaded again with it. */
export function setGlass(mode: Glass) {
  if (!__TEST_TOOLS__ || mode === glass) return;
  try {
    localStorage.setItem("ac:glass", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** Whether the glass blurs, for a mode and a device tier. */
export function glassBlurs(mode: Glass, tier: DeviceTier): boolean {
  if (mode === "auto") return tier === "full";
  return mode === "flou";
}

/** The value of <html data-glass> for a mode and a tier: "plein" when the
 *  glass does not blur, null (no attribute) when it does. */
export function glassAttribute(mode: Glass, tier: DeviceTier): "plein" | null {
  return glassBlurs(mode, tier) ? null : "plein";
}
