// When the map's two helper threads start — the relief worker (the plateau's
// relief tiles, relief/demClient.ts) and the mesh worker (the plateau's shape,
// gl/meshClient.ts) — compared live in the builds with the testing tools (the
// dev server and staging, __TEST_TOOLS__), kept in localStorage like the
// plateau lid's mode (plateau/lidSwitch.ts) and drawn as the DEV dialog's
// « Assistants » row:
//
// - "early" (the default): with the map object, while Mapbox still fetches
//   its style, tiles and letters. Neither worker touches the style, so neither
//   needs Mapbox's `load`; their scripts then arrive long before the first
//   plateau asks for them instead of queueing behind the boot's other files.
// - "load": as before — inside the map's `load` handler.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_BOOT_WORKERS.

export type BootWorkers = "early" | "load";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_BOOT_WORKERS: BootWorkers = "early";

export const BOOT_WORKERS: readonly BootWorkers[] = ["early", "load"];

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedBootWorkers(): BootWorkers {
  try {
    const raw = localStorage.getItem("ac:boot-workers");
    return (BOOT_WORKERS as readonly string[]).includes(raw ?? "")
      ? (raw as BootWorkers)
      : DEFAULT_BOOT_WORKERS;
  } catch {
    return DEFAULT_BOOT_WORKERS;
  }
}

/** This page load's mode. */
export const bootWorkers: BootWorkers = __TEST_TOOLS__ ? storedBootWorkers() : DEFAULT_BOOT_WORKERS;

/** Another mode: kept, and the page loaded again with it. */
export function setBootWorkers(mode: BootWorkers) {
  if (!__TEST_TOOLS__ || mode === bootWorkers) return;
  try {
    localStorage.setItem("ac:boot-workers", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** Where the workers start: right after the map object is made ("mount"),
 *  or in its `load` handler ("load"). */
export function workersStartAt(mode: BootWorkers): "mount" | "load" {
  return mode === "early" ? "mount" : "load";
}
