// Where two pieces of the map's work run during a selection, by the device's
// tier (shared/device/deviceTier, read at each use: a tier measured in the
// first flight applies from the next selection).
//
// A plateau fitted past the globe gets its mercator set first and its globe
// set later (gl/globeDeferral.ts), asked of the mesh worker as the mesh is
// (and again at once by a frame that nears the globe). A globe frame that
// comes before that set builds it on the page on a device whose tier is
// "full"; on every other it draws no plateau and no boundary line until the
// set lands (one repaint then) (`globeFrameWaitsFor`).
//
// The flat view's grey sheet, cut around the selection (gl/tintSheet.ts), is
// cut by the mesh worker on a device whose tier is "light" or "minimal",
// where the page's thread is the slow part (asked at the act and laid when it
// answers, a few frames later); on the page, in the act, on every other,
// where the cut takes less than the worker's round trip (`tintCutFor`). Both
// need a live worker; else the page.
//
// The boundary lines of a map with no unit raised come from the mesh worker
// too (composables/usePlateau's askLines), and the pins are rebuilt after the
// frame that follows the act (composables/useMapPins).
//
// No import and nothing run at load: loadable under node (threadSwitch.test.ts).

/** Whether a globe frame that finds no deferred globe set draws no plateau
 *  until the worker answers, instead of building it on the page. */
export function globeFrameWaitsFor(tier: "full" | "light" | "minimal"): boolean {
  return tier !== "full";
}

/** Who cuts a grey sheet asked for now: the worker on a device whose tier is
 *  not "full". */
export function tintCutFor(tier: "full" | "light" | "minimal"): "worker" | "page" {
  return tier === "full" ? "page" : "worker";
}
