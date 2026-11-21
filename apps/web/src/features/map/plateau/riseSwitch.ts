// When the plateau's rise starts (usePlateau), by the device's tier
// (shared/device/deviceTier), read at each rise:
//
// - "flight", on a device whose tier is "full": as soon as the plateau is
//   committed, inside the camera's flight when there is one.
// - "after", on a "light" or "minimal" device: when the camera's flight has
//   landed (lib/landing.ts), or after LAND_WAIT_CAP_MS if it has not;
//   meanwhile the unit lies flat, its lines and its grey cut already in
//   place. A map dragged under a finger is not a flight: nothing is waited
//   for.
//
// No import and nothing run at load: loadable under node (riseSwitch.test.ts).

/** When a rise starts. */
export type RiseStart = "flight" | "after";

/** A rise that waits for the camera starts anyway after this long, ms: past
 *  the longest flight (a result's arc, 3 s at most; a selection's is 0.55 s). */
export const LAND_WAIT_CAP_MS = 3500;

/** When a rise asked for now starts on a device of this tier. */
export function riseStartFor(tier: "full" | "light" | "minimal"): RiseStart {
  return tier === "full" ? "flight" : "after";
}
