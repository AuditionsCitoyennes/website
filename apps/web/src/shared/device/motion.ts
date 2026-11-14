// How much the page moves (`ac:motion`, the Témoignages page's DEV dialog's
// « Mouvement » row): "full", the designed motion, or "short", the lighter
// one for a visitor who asked the system for less motion
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
//   (features/geo-nav GeoPanel.vue, `.panel.snap`).
// Everything else moves as in "full": a selection's flight, the padding ease,
// the pins, the hover sweep.
//
// - "auto" (the default): "short" when the system asks for reduced motion or
//   the device's tier is not "full", "full" otherwise.
// - "full": the motion as it was before this switch, whatever the system
//   setting and the tier.
// - "short": the lighter motion on any device.
//
// Read at each use, with the system setting and the device's tier of that
// moment (a tier measured in the first flight applies from the next move): no
// reload. Production has neither key nor switch: DEFAULT_MOTION, so "auto".
//
// No import but vue's ref (the DEV dialog redraws on it) and ./deviceTier,
// and nothing run at load but the switch's read: loadable under node
// (motion.test.ts).
import { ref } from "vue";
import { deviceTier, type DeviceTier } from "./deviceTier";

export type MotionChoice = "auto" | "full" | "short";
/** How the page moves, once decided. */
export type Motion = "full" | "short";

/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_MOTION: MotionChoice = "auto";

export const MOTION_CHOICES: readonly MotionChoice[] = ["auto", "full", "short"];

/** A rise or a sink under "short" lasts this share of its time. */
export const SHORT_MOTION_SHARE = 0.4;

/** The kept choice, else the default (garbage or blocked storage too). */
export function storedMotion(): MotionChoice {
  try {
    const raw = localStorage.getItem("ac:motion");
    return (MOTION_CHOICES as readonly string[]).includes(raw ?? "")
      ? (raw as MotionChoice)
      : DEFAULT_MOTION;
  } catch {
    return DEFAULT_MOTION;
  }
}

/** The choice now. */
export const motionChoice = ref<MotionChoice>(__TEST_TOOLS__ ? storedMotion() : DEFAULT_MOTION);

/** Another choice: kept, and read by the next move (no reload). */
export function setMotionChoice(choice: MotionChoice) {
  if (!__TEST_TOOLS__) return;
  motionChoice.value = choice;
  try {
    localStorage.setItem("ac:motion", choice);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** The motion of a move made now: the choice, or under "auto" the system's
 *  reduced-motion setting and the device's tier. */
export function motionFor(choice: MotionChoice, tier: DeviceTier, reducedMotion: boolean): Motion {
  if (choice !== "auto") return choice;
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
  return motionFor(motionChoice.value, deviceTier(), prefersReducedMotion());
}

/** A move of `ms` under `motion`: its whole time, or SHORT_MOTION_SHARE of it
 *  (whole milliseconds, never 0 for a move that has a time). */
export function motionMs(ms: number, motion: Motion): number {
  return motion === "short" ? Math.ceil(ms * SHORT_MOTION_SHARE) : ms;
}
