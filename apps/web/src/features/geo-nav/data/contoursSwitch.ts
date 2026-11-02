// Where the explorer's outlines come from, compared live in the builds with
// the testing tools — the dev server and staging (__TEST_TOOLS__, vite.config),
// kept in localStorage like the Témoignages page's data source
// (temoignages/dataSource.ts) and drawn as its DEV switch's "Contours" row:
//
// - "api" (the default): the API's boundaries, as before.
// - "fichiers": the static outline files of one build (useOutlineFiles.ts, the
//   build named by apps/web/outlines.lock.json). Nothing reads them yet: only
//   the testing tools' `__acOutlines()` probe fetches a file.
//
// Read once per page load: switching reloads the page (the outlines' source
// is decided once for the session). Production has neither key nor switch:
// DEFAULT_CONTOURS_MODE.

export type ContoursMode = "api" | "fichiers";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_CONTOURS_MODE: ContoursMode = "api";

export const CONTOURS_MODES: readonly ContoursMode[] = ["api", "fichiers"];

function storedContoursMode(): ContoursMode {
  try {
    const raw = localStorage.getItem("ac:contours");
    return (CONTOURS_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as ContoursMode)
      : DEFAULT_CONTOURS_MODE;
  } catch {
    return DEFAULT_CONTOURS_MODE;
  }
}

/** This page load's mode. */
export const contoursMode: ContoursMode = __TEST_TOOLS__
  ? storedContoursMode()
  : DEFAULT_CONTOURS_MODE;

/** Another mode: kept, and the page loaded again with it. */
export function setContoursMode(mode: ContoursMode) {
  if (!__TEST_TOOLS__ || mode === contoursMode) return;
  try {
    localStorage.setItem("ac:contours", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

function storedOutlinesBuild(): string {
  try {
    return localStorage.getItem("ac:outlines-build") ?? "";
  } catch {
    return "";
  }
}

/** The outline build this page reads: the lock's (vite.config), or, with the
 *  testing tools, another one named by `ac:outlines-build` to compare with
 *  (absent or empty: the lock's). */
export const outlinesBuild: string =
  (__TEST_TOOLS__ && storedOutlinesBuild()) || __OUTLINES_BUILD__;
