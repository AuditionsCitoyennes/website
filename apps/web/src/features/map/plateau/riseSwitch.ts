// Two experiments on the plateau's rise (usePlateau), compared live in the
// builds with the testing tools (the Témoignages page's DEV dialog, « Montée »
// and « Ordre ») and kept in localStorage like the ground's choice
// (relief/groundSwitch.ts).
//
// `ac:rise` — how the ground under the plateau is raised and lowered:
// - "steps" (the default): one setTerrain a frame, about 18 for a rise and 9
//   for a sink, each with the rise's own eased height. Each one is a style
//   change for mapbox, which draws the whole draped ground again at the next
//   frame.
// - "transition": one setTerrain for the rise and one for the sink, with the
//   move's time as the exaggeration's transition; mapbox interpolates the
//   height itself and the plateau's layer reads the height of each frame, so
//   the walls and the lid stand where the ground is drawn (usePlateau,
//   lib/terrainFollow.ts). The curve is mapbox's (ease-in-out), not the
//   rise's ease-out: the move starts more slowly. Over flat ground
//   (`ac:relief-ground`) there is no terrain to move and both do the same.
//
// `ac:rise-order` — when the rise starts:
// - "flight": as soon as the plateau is committed, inside the camera's flight
//   when there is one (the rise as it was).
// - "after": when the camera's flight has landed (lib/landing.ts), or after
//   LAND_WAIT_CAP_MS if it has not; meanwhile the unit lies flat, its lines
//   and its grey cut already in place. A map dragged under a finger is not a
//   flight: nothing is waited for.
// - "auto" (the default): "after" on a device whose tier is "light" or
//   "minimal" (shared/device/deviceTier), "flight" on every other.
//
// Both are read at each rise, with the device's tier of that moment: no
// reload. Production has neither key nor switch: the defaults.
//
// No import but vue's ref (the DEV dialog redraws on it) and nothing run at
// load but the switches' reads: loadable under node (riseSwitch.test.ts).
import { ref } from "vue";

export type RiseMode = "steps" | "transition";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_RISE_MODE: RiseMode = "steps";

export const RISE_MODES: readonly RiseMode[] = ["steps", "transition"];

export type RiseOrder = "auto" | "flight" | "after";
/** When a rise starts, once decided. */
export type RiseStart = "flight" | "after";

/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_RISE_ORDER: RiseOrder = "auto";

export const RISE_ORDERS: readonly RiseOrder[] = ["auto", "flight", "after"];

/** A rise that waits for the camera starts anyway after this long, ms: past
 *  the longest flight (a result's arc, 3 s at most; a selection's is 0.55 s). */
export const LAND_WAIT_CAP_MS = 3500;

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** The kept mode, else the default (garbage or blocked storage too). */
export const storedRiseMode = (): RiseMode => stored("ac:rise", RISE_MODES, DEFAULT_RISE_MODE);

/** The kept order, else the default (garbage or blocked storage too). */
export const storedRiseOrder = (): RiseOrder =>
  stored("ac:rise-order", RISE_ORDERS, DEFAULT_RISE_ORDER);

/** The mode now. */
export const riseMode = ref<RiseMode>(__TEST_TOOLS__ ? storedRiseMode() : DEFAULT_RISE_MODE);

/** The order now. */
export const riseOrder = ref<RiseOrder>(__TEST_TOOLS__ ? storedRiseOrder() : DEFAULT_RISE_ORDER);

/** Another mode: kept, and read by the next rise or sink (no reload). */
export function setRiseMode(mode: RiseMode) {
  if (!__TEST_TOOLS__) return;
  riseMode.value = mode;
  keep("ac:rise", mode);
}

/** Another order: kept, and read by the next rise (no reload). */
export function setRiseOrder(order: RiseOrder) {
  if (!__TEST_TOOLS__) return;
  riseOrder.value = order;
  keep("ac:rise-order", order);
}

/** When a rise asked for now starts: the choice, or under "auto" the device's
 *  tier (`tier`: "full", "light" or "minimal"). */
export function riseStartFor(choice: RiseOrder, tier: "full" | "light" | "minimal"): RiseStart {
  if (choice !== "auto") return choice;
  return tier === "full" ? "flight" : "after";
}
