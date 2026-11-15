// What the plateau stands on (`ac:relief-ground`, the Témoignages page's DEV
// switch's "Sol" row):
//
// - "relief": the ground rises with the plateau — the unit's own DEM (the
//   relief worker's tiles) as the map's terrain, its exaggeration animated,
//   so the map draped under the lid, the pins and the draped colours stand at
//   the plateau's height.
// - "flat": the ground stays where it is. The wall, the lid, its lines, the
//   halo, the grey outside and the rise are the plateau's own layer and do
//   not change; no DEM tile is made, the relief worker is not started, and
//   the map draws without a terrain (on the globe, below zoom 6, mapbox
//   drapes whatever the terrain: there it is a flat one). The pins of the
//   raised unit are lifted to the lid's height and a pointer over the lid
//   reads the lid, so both stay in step with the picture on it. The audit of
//   2026-11-12 measured it on a slow processor: about 60 % less time in long
//   frames over three flights.
// - "auto" (the default): "flat" on a device whose tier is "light" or
//   "minimal" (shared/device/deviceTier), "relief" on every other.
//
// Read at each selection, with the device's tier of that moment (a tier
// measured in the first flight applies from the next territory): a plateau
// standing keeps the ground it was raised on. Production has neither key nor
// switch: DEFAULT_RELIEF_GROUND, so "auto".
//
// No import but vue's ref (the DEV dialog redraws on it) and nothing run at
// load but the switch's read: loadable under node (groundSwitch.test.ts).
import { ref } from "vue";

export type ReliefGround = "auto" | "relief" | "flat";
/** What a plateau stands on, once decided. */
export type Ground = "relief" | "flat";

/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_RELIEF_GROUND: ReliefGround = "auto";

export const RELIEF_GROUNDS: readonly ReliefGround[] = ["auto", "relief", "flat"];

/** The kept choice, else the default (garbage or blocked storage too). */
export function storedReliefGround(): ReliefGround {
  try {
    const raw = localStorage.getItem("ac:relief-ground");
    return (RELIEF_GROUNDS as readonly string[]).includes(raw ?? "")
      ? (raw as ReliefGround)
      : DEFAULT_RELIEF_GROUND;
  } catch {
    return DEFAULT_RELIEF_GROUND;
  }
}

/** The choice now. */
export const reliefGround = ref<ReliefGround>(
  __TEST_TOOLS__ ? storedReliefGround() : DEFAULT_RELIEF_GROUND,
);

/** Another choice: kept, and read by the next selection (no reload). */
export function setReliefGround(ground: ReliefGround) {
  if (!__TEST_TOOLS__) return;
  reliefGround.value = ground;
  try {
    localStorage.setItem("ac:relief-ground", ground);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** The ground of a plateau raised now: the choice, or under "auto" the
 *  device's tier (`tier`: "full", "light" or "minimal"). */
export function groundFor(choice: ReliefGround, tier: "full" | "light" | "minimal"): Ground {
  if (choice !== "auto") return choice;
  return tier === "full" ? "relief" : "flat";
}

/** The WebGL renderer's name of a context somebody already has (the map's):
 *  what the device's tier reads to tell a software renderer. Null where the
 *  browser does not say. */
export function rendererOf(
  gl: Pick<WebGLRenderingContext, "getExtension" | "getParameter" | "RENDERER"> | null | undefined,
): string | null {
  if (!gl) return null;
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info") as {
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}
