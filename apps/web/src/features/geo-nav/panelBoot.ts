// The Témoignages page's panel while the page loads (panelBootSwitch): held
// out of sight under the boot curtain, on a phone (the lowered sheet's strip)
// and on a desktop (the side panel) alike, so that only the loading
// placeholder shows; it comes in as the curtain leaves, whatever made it
// leave (GeoNav's `booting`: the map ready, ready "late", the map
// unavailable, the testimonies failing, or the curtain's 10 s cap). Held, it
// keeps its box (`visibility: hidden`, never `display: none`): the sheet's
// measures, the camera's padding and the curtain's poster stay where they
// will be once it shows, and nothing moves when it does.
//
// The home page's card has no panel on show: nothing to hold. A page whose
// map was already up (back from the home page, the map kept alive in its
// card) has no curtain: the panel shows at once.
//
// This module holds the rules alone. No import but a type, nothing run at
// load: loadable under node (panelBoot.test.ts).
import type { DeviceTier } from "@/shared/device/deviceTier";

/** "apres": the panel waits for the curtain to leave; "tout-de-suite": it
 *  shows from the page's first render, the curtain under it (as before). */
export type PanelBootMode = "apres" | "tout-de-suite";

/** The switch's choices, in the DEV dialog's order. */
export const PANEL_BOOT_MODES: readonly PanelBootMode[] = ["apres", "tout-de-suite"];

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_PANEL_BOOT: PanelBootMode = "apres";

/** The panel is held out of sight now: under « Après le chargement », while
 *  the curtain is up, on the page (not the home page's card). `booting` is
 *  GeoNav's latch, so a hold never comes back once lifted. */
export function panelHeldAtBoot(o: {
  mode: PanelBootMode;
  booting: boolean;
  preview: boolean;
}): boolean {
  return o.mode === "apres" && o.booting && !o.preview;
}

/** One part of the panel's entrance (Web Animations, GeoPanel): each runs
 *  on its own property, with its own time and easing. */
export interface EntrancePart {
  keyframes: Keyframe[];
  duration: number;
  easing: string;
}

/** The full entrance's slide and fade (ms) and the slide's easing, those of
 *  the card's own `panel-arrive` (GeoNav): the curtain's fade (0.45 s) plays
 *  meanwhile. */
export const ENTRANCE_SLIDE_MS = 550;
export const ENTRANCE_FADE_MS = 450;
export const ENTRANCE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/** A weak device's entrance: a short fade alone. */
export const ENTRANCE_SHORT_MS = 200;
/** How far (rem) a desktop's side panel slides in from the right. */
export const ENTRANCE_DESK_REM = 2.5;

/** How the panel comes in: no part at all (the visitor asked for reduced
 *  motion); a short fade on a weak device; else, on a phone, the lowered
 *  strip rising from just under the screen's edge (`peekPx`: its height on
 *  screen) and, on a desktop, the side panel sliding in from the right, each
 *  fading in. `translate`, never `transform`: the sheet and the fold own the
 *  transform. */
export function panelEntrance(o: {
  phone: boolean;
  peekPx: number;
  reduced: boolean;
  tier: DeviceTier;
}): EntrancePart[] {
  if (o.reduced) return [];
  const fade = (duration: number): EntrancePart => ({
    keyframes: [{ opacity: 0 }, { opacity: 1 }],
    duration,
    easing: "ease",
  });
  if (o.tier !== "full") return [fade(ENTRANCE_SHORT_MS)];
  const from = o.phone ? `0 ${Math.max(0, Math.round(o.peekPx))}px` : `${ENTRANCE_DESK_REM}rem 0`;
  return [
    fade(ENTRANCE_FADE_MS),
    {
      keyframes: [{ translate: from }, { translate: "0 0" }],
      duration: ENTRANCE_SLIDE_MS,
      easing: ENTRANCE_EASING,
    },
  ];
}
