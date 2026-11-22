// How much the page moves: "full", the designed motion, or "short", the
// lighter one for a visitor who asked the system for less motion
// (prefers-reduced-motion) and for a weak device (./deviceTier: "light" or
// "minimal").
//
// What "short" changes, each at its point of use:
// - the map's cold-load entrance: the camera goes to its tilted framing in
//   one step, with no 0.9 s tilt (features/map useMapCamera.beginIntro);
// - a result opened from another: the map eases straight to the lieu, with no
//   pull-back on the way (useMapCamera.runCamera, the spotlight's arc);
// - the plateau's rise and sink, and the analyses' slabs': SHORT_MOTION_SHARE
//   of their time (`motionMs`: features/map usePlateau.animateTerrain,
//   usePlateauSlabs.animateSlabs);
// - an audition unfolding in the panel: at once, with no height tween
//   (shared/ui/transition/ExpandTransition.vue);
// - the panel widening, narrowing or sliding aside on a desktop: at once
//   (features/geo-nav GeoPanel.vue, `.panel.snap`);
// - a phone's raised sheet refitting to its content while at rest: in one
//   step (features/geo-nav panel/sheetFit refitMotion). A raise or a lower
//   still eases. The map's controls and the testing tools' buttons that stand
//   on its top follow the sheet's own motion, stepping when it steps
//   (GeoNav's `--sheet-follow`).
// Everything else moves as in "full": a selection's flight, the padding ease,
// the pins, the hover sweep.
//
// Read at each use, with the system setting and the device's tier of that
// moment (a tier measured in the first flight applies from the next move).
//
// No import but ./deviceTier, and nothing run at load: loadable under node
// (motion.test.ts).
import { deviceTier, type DeviceTier } from "./deviceTier";

/** How the page moves. */
export type Motion = "full" | "short";

/** A rise or a sink under "short" lasts this share of its time. */
export const SHORT_MOTION_SHARE = 0.4;

/** The motion of a move made now: short when the system asks for reduced
 *  motion or the device's tier is not "full". */
export function motionFor(tier: DeviceTier, reducedMotion: boolean): Motion {
  return reducedMotion || tier !== "full" ? "short" : "full";
}

/** The system's reduced-motion query, asked once per window: its `matches`
 *  follows the setting, and the panel reads it at every render. */
let query: { win: Window; list: MediaQueryList } | null = null;

/** The system asks for reduced motion. False where it cannot be asked (no
 *  window, no matchMedia). */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    if (query?.win !== window) {
      query = { win: window, list: window.matchMedia("(prefers-reduced-motion: reduce)") };
    }
    return query.list.matches;
  } catch {
    return false;
  }
}

/** The motion now. */
export function motionNow(): Motion {
  return motionFor(deviceTier(), prefersReducedMotion());
}

/** A move of `ms` under `motion`: its whole time, or SHORT_MOTION_SHARE of it
 *  (whole milliseconds, never 0 for a move that has a time). */
export function motionMs(ms: number, motion: Motion): number {
  return motion === "short" ? Math.ceil(ms * SHORT_MOTION_SHARE) : ms;
}
