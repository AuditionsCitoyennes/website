// The Témoignages page's panel while the page loads: held
// out of sight under the boot curtain, on a phone (the lowered sheet's strip)
// and on a desktop (the side panel) alike, so that only the loading
// placeholder shows; it comes in as the curtain's fade starts, whatever made
// it leave (GeoNav's `booting`: the map ready, ready "late", the testimonies
// failing, or the curtain's 10 s cap), but the map's fallback: while « La
// carte n'a pas pu s'afficher. » shows, the panel stays out of sight. Not when
// it is told to leave: on a heavy first map frame the curtain can stay opaque
// a while after that, and the panel would be in already, over it. Held, it
// keeps its box (transparent and inert, never `display: none`): the sheet's
// measures and the camera's padding stay what they will be once it shows,
// and the map does not move when it does. What the curtain draws where
// meanwhile: shared/ui/MapCurtain.vue, by shared/boot/curtainFrame.ts.
//
// The home page's card has no panel on show: nothing to hold. A page whose
// map was already up (back from the home page, the map kept alive in its
// card) has no curtain: the panel shows at once.
//
// This module holds the rules alone. No import but a type, nothing run at
// load: loadable under node (panelBoot.test.ts).
import type { DeviceTier } from "@/shared/device/deviceTier";

/** The panel is held out of sight now, on the page (not the home page's
 *  card): while the curtain is up or leaving but not fading yet
 *  (`awaitingFade`), and while the map's box shows its fallback
 *  (`mapFailed`: « La carte n'a pas pu s'afficher. », GeoDrillMap's
 *  `fallback`), which then stands alone.
 *  `booting` is GeoNav's latch and the wait only ever ends, so the boot's
 *  hold never comes back once lifted; the fallback's goes with it (a
 *  « Réessayer » that brings the map), and the panel comes in as after the
 *  curtain. */
export function panelHeldAtBoot(o: {
  booting: boolean;
  awaitingFade: boolean;
  mapFailed: boolean;
  preview: boolean;
}): boolean {
  return (o.booting || o.awaitingFade || o.mapFailed) && !o.preview;
}

/** How long (ms) after the curtain is told to leave the panel waits at most
 *  for its fade to start (GeoNav `awaitingFade`), should neither the fade nor
 *  its end ever be seen. A belt: Vue's own timer ends the leave. Longer than
 *  the stall between the leave and its fade on a heavy first map frame
 *  (measured up to 1.4 s headless), so that it does not end the wait inside
 *  one. */
export const CURTAIN_FADE_BELT_MS = 2_000;

/** How long (ms) the panel fades out when it is held again after it was on
 *  screen (the map failing after the page was up, GeoNav's `onMapFallback`):
 *  the card's own `panel-arrive` leave. */
export const HOLD_FADE_MS = 200;

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
