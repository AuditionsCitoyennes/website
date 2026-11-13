// Whether the map page's code is asked for from the HTML, compared live in the
// builds with the testing tools (the dev server and staging, __TEST_TOOLS__),
// kept in localStorage and drawn as the DEV dialog's « Code de la carte » row:
//
// - "html" (the default): on a first load of the map page, an inline script of
//   index.html asks for the map's code (its chunks and their stylesheets) at
//   once, beside the entry, before the entry runs (mapPreloadPlan.ts, written
//   into the page by vite.config.ts at build time). The list and the plateau
//   come sooner, the first paint a little later.
// - "page": as before. The map's code is asked for once the entry has run, the
//   router has loaded the page and the page has lent the stage to the map.
//
// The switch is read by the inline script itself (this module only shows and
// sets it), so a change applies on the next load: switching reloads the page.
// The dev server has no built files to name, so it asks for nothing early,
// whatever the choice. Production has neither key nor switch:
// DEFAULT_MAP_PRELOAD, baked into the script.

import {
  DEFAULT_MAP_PRELOAD,
  MAP_PRELOAD_KEY,
  MAP_PRELOADS,
  type MapPreload,
} from "./mapPreloadPlan";

export { DEFAULT_MAP_PRELOAD, MAP_PRELOADS, type MapPreload };

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedMapPreload(): MapPreload {
  try {
    const raw = localStorage.getItem(MAP_PRELOAD_KEY);
    return (MAP_PRELOADS as readonly string[]).includes(raw ?? "")
      ? (raw as MapPreload)
      : DEFAULT_MAP_PRELOAD;
  } catch {
    return DEFAULT_MAP_PRELOAD;
  }
}

/** This page load's mode. */
export const mapPreload: MapPreload = __TEST_TOOLS__ ? storedMapPreload() : DEFAULT_MAP_PRELOAD;

/** Another mode: kept, and the page loaded again with it. */
export function setMapPreload(mode: MapPreload) {
  if (!__TEST_TOOLS__ || mode === mapPreload) return;
  try {
    localStorage.setItem(MAP_PRELOAD_KEY, mode);
  } catch {
    /* storage blocked (a private window): the script reads the default */
  }
  window.location.reload();
}
