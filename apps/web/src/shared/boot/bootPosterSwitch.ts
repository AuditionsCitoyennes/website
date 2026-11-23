// How the map's loading curtain draws France (shared/boot/curtainFrame.ts),
// compared live (the testing options menu, temoignages/DevOptionsMenu.vue) in
// the builds with the testing tools — the dev server and staging
// (__TEST_TOOLS__, vite.config): "carte" (the default) — where and as the map
// shows France when the curtain leaves: flat on the globe under full motion,
// tilted under short — "plat" — flat, centred on the tilted map's France and
// as wide — or "avant": where each of the curtain's two stages drew it
// before, which moved from one to the other.
//
// Read once per page load: the choice only matters while the map loads, so
// its setter loads the page again. Production has neither key nor switch:
// DEFAULT_BOOT_POSTER.
//
// Pure: loadable under node (devOptions.test.ts, bootPosterSwitch.test.ts).
import { BOOT_POSTERS, DEFAULT_BOOT_POSTER, type BootPoster } from "./curtainFrame";

export { BOOT_POSTERS, DEFAULT_BOOT_POSTER, type BootPoster } from "./curtainFrame";

const BOOT_POSTER_KEY = "ac:boot-poster";

/** The kept choice, else the default (garbage or blocked storage too). */
export function storedBootPoster(): BootPoster {
  try {
    const raw = localStorage.getItem(BOOT_POSTER_KEY);
    return (BOOT_POSTERS as readonly string[]).includes(raw ?? "")
      ? (raw as BootPoster)
      : DEFAULT_BOOT_POSTER;
  } catch {
    return DEFAULT_BOOT_POSTER;
  }
}

/** This page load's choice. */
export const bootPosterMode: BootPoster = __TEST_TOOLS__ ? storedBootPoster() : DEFAULT_BOOT_POSTER;

/** Another choice: kept, and the page loaded again with it. */
export function setBootPosterMode(mode: BootPoster) {
  if (!__TEST_TOOLS__ || mode === bootPosterMode) return;
  try {
    localStorage.setItem(BOOT_POSTER_KEY, mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}
