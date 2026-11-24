// What a phone's camera does when a short raised sheet's list came in once
// the tap's flight had landed, leaving more map above it (« Recadrage
// tardif »), compared live (the Témoignages page's testing options menu,
// temoignages/DevOptionsMenu.vue) in the builds with the testing tools — the
// dev server and staging (__TEST_TOOLS__, vite.config): "rester" (the
// default) keeps the territory where the flight put it (one move per tap);
// "recentrer" centres it in the map left above the sheet by a second move
// (sheetFit SheetLateMode, useSheetBand). Read at each decision, so a choice
// applies at once, with no reload. Production keeps the default, which this
// ref never leaves there (no switch is drawn). Desktops have no sheet: the
// switch changes nothing there.
import { ref } from "vue";
import { DEFAULT_SHEET_LATE, SHEET_LATE_MODES, type SheetLateMode } from "./sheetFit";

export type { SheetLateMode } from "./sheetFit";

const enabled = __TEST_TOOLS__;
const SHEET_LATE_KEY = "ac:sheet-late";

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (!enabled) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

// Read only in the builds with the testing tools: production has neither the
// key nor the call.
export const sheetLateMode = ref<SheetLateMode>(
  __TEST_TOOLS__
    ? stored(SHEET_LATE_KEY, SHEET_LATE_MODES, DEFAULT_SHEET_LATE)
    : DEFAULT_SHEET_LATE,
);

export function setSheetLateMode(m: SheetLateMode) {
  if (!enabled) return;
  sheetLateMode.value = m;
  try {
    localStorage.setItem(SHEET_LATE_KEY, m);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
