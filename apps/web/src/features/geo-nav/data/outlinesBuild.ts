// Which outline build the explorer reads (useOutlineFiles.ts): the one named
// by apps/web/outlines.lock.json, or, in the builds with the testing tools —
// the dev server and staging (__TEST_TOOLS__, vite.config) — another one kept
// in localStorage under `ac:outlines-build`, to compare with (no DEV switch
// row: set by hand or by a measurement script).
//
// Read once per page load: switching reloads the page (the session's files
// come from one build). Production has neither key nor switch: it reads
// `__OUTLINES_BUILD__` (the lock).

function storedOutlinesBuild(): string {
  try {
    return localStorage.getItem("ac:outlines-build") ?? "";
  } catch {
    return "";
  }
}

/** The outline build this page reads: the lock's, or, with the testing
 *  tools, the one `ac:outlines-build` names (absent or empty: the lock's). */
export const outlinesBuild: string = __TEST_TOOLS__
  ? storedOutlinesBuild() || __OUTLINES_BUILD__
  : __OUTLINES_BUILD__;
