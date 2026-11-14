// How the home page's map card opens into the map page (map-stage/MapStage.vue),
// compared live in the builds with the testing tools (the dev server and
// staging, __TEST_TOOLS__), kept in localStorage and drawn as the DEV dialog's
// « Ouverture de la carte » row:
//
// - "grandir": the card grows into the page over 0.65 s, as before on every
//   device. Each frame of the growth resizes the map's drawing surface,
//   frames the map again and draws it at once, on top of Mapbox's own frame.
// - "direct": the page appears at once, as it already does for a visitor who
//   asked the system for reduced motion: one resize, one framing.
// - "auto" (the default): "grandir" on a device of the tier "full",
//   "direct" on a weak one (the tier "light" or "minimal",
//   shared/device/deviceTier.ts). On a weak device the card is a still
//   picture by default anyway (features/home/homeMapPolicy.ts), so this
//   matters there only when the live card was chosen.
//
// Reduced motion is always "direct". Read once per page load; the tier is read
// at each opening. Switching reloads the page. Production has neither key nor
// switch: DEFAULT_CARD_OPEN, so "auto".
//
// Pure: loadable under node (cardOpenSwitch.test.ts).

import type { DeviceTier } from "./deviceTier";

export type CardOpen = "auto" | "grandir" | "direct";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_CARD_OPEN: CardOpen = "auto";

export const CARD_OPENS: readonly CardOpen[] = ["auto", "grandir", "direct"];

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedCardOpen(): CardOpen {
  try {
    const raw = localStorage.getItem("ac:card-open");
    return (CARD_OPENS as readonly string[]).includes(raw ?? "")
      ? (raw as CardOpen)
      : DEFAULT_CARD_OPEN;
  } catch {
    return DEFAULT_CARD_OPEN;
  }
}

/** This page load's mode. */
export const cardOpen: CardOpen = __TEST_TOOLS__ ? storedCardOpen() : DEFAULT_CARD_OPEN;

/** Another mode: kept, and the page loaded again with it. */
export function setCardOpen(mode: CardOpen) {
  if (!__TEST_TOOLS__ || mode === cardOpen) return;
  try {
    localStorage.setItem("ac:card-open", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** Whether the card grows into the page, for a mode, a device tier and the
 *  system's reduced-motion setting. */
export function cardGrows(mode: CardOpen, tier: DeviceTier, reducedMotion: boolean): boolean {
  if (reducedMotion) return false;
  if (mode === "auto") return tier === "full";
  return mode === "grandir";
}
