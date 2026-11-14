// When the home page's map card is lent to the map, or whether it is at all
// (useMapCardSlot.ts): the policies, the switch that compares them in the
// builds with the testing tools, and the rule "auto" follows.
//
// - "auto" (the policy of every build without the testing tools, and the
//   switch's default): "proche" on a device of the tier "full", "statique" on
//   a weak one (the tier "light" or "minimal", shared/device/deviceTier.ts) or
//   on one without WebGL 2, where the map cannot run.
// - "proche": from the visitor's first scroll away from the top on, a screen
//   ahead — today's behaviour on every device.
// - "tot": also once the page itself is in and the browser has a moment.
// - "contact": reached only.
// - "statique": never lent. The card is a still picture of France (our own
//   outlines, shared/ui/FrancePoster.vue) and one link to the map page, where
//   the map loads when the visitor chose it. On the weak phone of the audit
//   the live card cost 6 to 7 frames over 100 ms during the scroll (1.9 to
//   2.6 s of long frames), and the map's whole download.
//
// Kept in localStorage like the Témoignages page's data switches and read
// once per page load: switching reloads the page (DevHomeMapSwitch,
// window.__acHomeMap). Pure: loadable under node (homeMapPolicy.test.ts).

import type { DeviceTier } from "../../shared/device/deviceTier";

export type HomeMapPolicy = "auto" | "proche" | "tot" | "contact" | "statique";
/** What "auto" becomes. */
export type HomeMapResolved = Exclude<HomeMapPolicy, "auto">;

/** The policy of a build without the testing tools, and the switch's default. */
export const DEFAULT_HOME_MAP: HomeMapPolicy = "auto";

export const HOME_MAP_POLICIES: readonly HomeMapPolicy[] = [
  "auto",
  "proche",
  "tot",
  "contact",
  "statique",
];
export const HOME_MAP_KEY = "ac:home-map";

/** The kept policy, else the default (garbage or blocked storage too). */
export function storedHomeMap(): HomeMapPolicy {
  try {
    const raw = localStorage.getItem(HOME_MAP_KEY);
    return (HOME_MAP_POLICIES as readonly string[]).includes(raw ?? "")
      ? (raw as HomeMapPolicy)
      : DEFAULT_HOME_MAP;
  } catch {
    return DEFAULT_HOME_MAP;
  }
}

/**
 * The policy in force. `tier`: the device's; `webgl2`: whether the browser
 * makes a WebGL 2 context (undefined: not probed yet, read as yes — the
 * caller probes before it lends the card).
 */
export function resolveHomeMap(
  policy: HomeMapPolicy,
  tier: DeviceTier,
  webgl2?: boolean,
): HomeMapResolved {
  if (policy !== "auto") return policy;
  if (tier !== "full" || webgl2 === false) return "statique";
  return "proche";
}

/** Whether "auto" may still change its mind once the browser is probed (the
 *  tier read from the hints alone is "full"). */
export const needsProbe = (policy: HomeMapPolicy, hintTier: DeviceTier) =>
  policy === "auto" && hintTier === "full";
