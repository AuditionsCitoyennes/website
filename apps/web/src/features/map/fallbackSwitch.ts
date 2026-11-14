// What the map's box shows when the map cannot start (GeoDrillMap.vue: no
// token in the build, the style refused, no WebGL, the engine failing),
// compared live in the builds with the testing tools (the dev server and
// staging, __TEST_TOOLS__), kept in localStorage and drawn as the DEV dialog's
// « Carte indisponible » row:
//
// - "visiteur" (the default): a still picture of France (our own outlines,
//   shared/ui/FrancePoster.vue), muted, under one plain sentence for
//   visitors. The developer's hint (the token's variable) goes to the console,
//   in a development build only.
// - "ancien": as before, « Carte indisponible. » and the developer's hint
//   about the token's variable, shown to every visitor.
// - "essai": the map is not started at all, so that the fallback of
//   "visiteur" can be looked at on any machine (no Mapbox load is billed).
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_MAP_FALLBACK.
//
// Pure: loadable under node (fallbackSwitch.test.ts).

export type MapFallback = "visiteur" | "ancien" | "essai";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_MAP_FALLBACK: MapFallback = "visiteur";

export const MAP_FALLBACKS: readonly MapFallback[] = ["visiteur", "ancien", "essai"];

/** The sentence a visitor reads in the map's box when it cannot start. */
export const MAP_FALLBACK_TEXT = "La carte n'a pas pu s'afficher.";

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedMapFallback(): MapFallback {
  try {
    const raw = localStorage.getItem("ac:map-fallback");
    return (MAP_FALLBACKS as readonly string[]).includes(raw ?? "")
      ? (raw as MapFallback)
      : DEFAULT_MAP_FALLBACK;
  } catch {
    return DEFAULT_MAP_FALLBACK;
  }
}

/** This page load's mode. */
export const mapFallback: MapFallback = __TEST_TOOLS__ ? storedMapFallback() : DEFAULT_MAP_FALLBACK;

/** Another mode: kept, and the page loaded again with it. */
export function setMapFallback(mode: MapFallback) {
  if (!__TEST_TOOLS__ || mode === mapFallback) return;
  try {
    localStorage.setItem("ac:map-fallback", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** What the fallback shows in a mode: the picture of France, and whose
 *  sentence (the visitor's, or the old developer's hint). */
export function fallbackView(mode: MapFallback): { poster: boolean; developerHint: boolean } {
  return mode === "ancien"
    ? { poster: false, developerHint: true }
    : { poster: true, developerHint: false };
}

/** The map is not started at all (to look at the fallback). */
export const fallbackForced = (mode: MapFallback) => mode === "essai";
