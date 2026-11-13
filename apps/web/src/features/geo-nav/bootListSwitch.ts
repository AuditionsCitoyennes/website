// What the Témoignages page's boot curtain covers while the map gets ready,
// compared live in the builds with the testing tools — the dev server and
// staging (__TEST_TOOLS__, vite.config), kept in localStorage like the
// plateau lid's mode (map/plateau/lidSwitch.ts) and drawn as its DEV switch's
// « Liste » row:
//
// - "first" (the default): the curtain covers the map's box only. It sits
//   under the panel (the side panel on a desktop, the bottom sheet on a
//   phone), so the list of places is usable as soon as its rows are in, while
//   the map behind it finishes its first paint. It lifts by the same rule as
//   before (GeoNav's `booting`), so the map's entrance is unchanged. A row
//   chosen before the map is ready moves the panel at once; the camera
//   command it gives is a prop of the map, which the map plays at its load.
// - "curtain": as before — one curtain over the map AND the panel until the
//   map is presentable (or the 10 s cap).
//
// The home page's card (GeoNav `preview`) has no panel to show: it keeps the
// whole curtain whatever the switch says.
//
// Read once per page load: switching reloads the page (the curtain only
// exists during the boot). Production has neither key nor switch:
// DEFAULT_BOOT_LIST.

export type BootList = "first" | "curtain";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_BOOT_LIST: BootList = "first";

export const BOOT_LISTS: readonly BootList[] = ["first", "curtain"];

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedBootList(): BootList {
  try {
    const raw = localStorage.getItem("ac:boot-list");
    return (BOOT_LISTS as readonly string[]).includes(raw ?? "")
      ? (raw as BootList)
      : DEFAULT_BOOT_LIST;
  } catch {
    return DEFAULT_BOOT_LIST;
  }
}

/** This page load's mode. */
export const bootList: BootList = __TEST_TOOLS__ ? storedBootList() : DEFAULT_BOOT_LIST;

/** Another mode: kept, and the page loaded again with it. */
export function setBootList(mode: BootList) {
  if (!__TEST_TOOLS__ || mode === bootList) return;
  try {
    localStorage.setItem("ac:boot-list", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** What the boot curtain covers: the map's box alone (the panel usable over
 *  it), or the whole page (map and panel). A card has no panel: all. */
export function bootCurtainCover(mode: BootList, preview: boolean): "map" | "all" {
  return mode === "first" && !preview ? "map" : "all";
}
