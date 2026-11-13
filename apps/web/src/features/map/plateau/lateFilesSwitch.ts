// What an outline file does when it lands while nothing waits for it — a
// unit's children, its neighbours, the world's outlines, the file of a unit
// the visitor has already left — compared live in the builds with the testing
// tools (the dev server and staging: __TEST_TOOLS__, vite.config), kept in
// localStorage like the plateau mesh's mode (meshSwitch.ts) and drawn as the
// Témoignages page's DEV dialog's "Fichiers tardifs" row:
//
// - "quiet" (the default): the file is kept as text and parsed, checked and
//   stored only once the map is still (lib/stillMap.ts) — the kept files in
//   one write (geo's outlineLoader, `late`). The lines it brings around a
//   standing plateau are then drawn by one reshape in place
//   (usePlateau.redress), and an outline that changes nothing standing does
//   nothing (lib/outlineChange.ts): the plateau pipeline runs once per
//   selection. Each file is asked at a fetch priority: high for the one the
//   selected unit's plateau waits for, low for the others. A unit's plateau
//   whose own file shares the link with the file of a unit just left waits
//   once more for it, and is not remembered as slow (data/selfHold.ts).
// - "direct": as before — every file parsed and stored as it lands, each
//   write a new run of the plateau pipeline, no fetch priority.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_LATE_FILES.

export type LateFilesMode = "quiet" | "direct";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_LATE_FILES: LateFilesMode = "quiet";

export const LATE_FILES_MODES: readonly LateFilesMode[] = ["quiet", "direct"];

/** The longest a kept file waits for a still map: past it, it is stored
 *  anyway (a map that never comes to rest still gets its lines). */
export const LATE_CAP_MS = 5000;

function storedLateFiles(): LateFilesMode {
  try {
    const raw = localStorage.getItem("ac:late-files");
    return (LATE_FILES_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as LateFilesMode)
      : DEFAULT_LATE_FILES;
  } catch {
    return DEFAULT_LATE_FILES;
  }
}

/** This page load's mode. */
export const lateFilesMode: LateFilesMode = __TEST_TOOLS__ ? storedLateFiles() : DEFAULT_LATE_FILES;

/** Another mode: kept, and the page loaded again with it. */
export function setLateFilesMode(mode: LateFilesMode) {
  if (!__TEST_TOOLS__ || mode === lateFilesMode) return;
  try {
    localStorage.setItem("ac:late-files", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}
