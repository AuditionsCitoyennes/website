// How tall a phone's raised sheet stands, compared live (the Témoignages
// page's testing options menu, temoignages/DevOptionsMenu.vue), in the builds
// with the testing tools — the dev server and staging (__TEST_TOOLS__,
// vite.config): "ajuste" (the default) — as tall as its head and its content
// need, up to the full panel (sheetFit.ts) —, "centre": the same, and an open
// lieu's pin aimed into the map left above a short sheet (sheetFit
// lieuAimPx, usePanelLayout's camera padding), the raised territory in scope
// centred and fitted there otherwise (sheetFit sheetBandInsets, useSheetBand,
// the camera's padding with each fit) — or "plein": always the full
// panel, as before. Read by useBottomSheet at each measure, by the camera's
// padding and by the band, so a choice applies at once, with no reload.
// Production keeps the default, which this ref never leaves there (no switch
// is drawn). Desktops have no sheet: the
// switch changes nothing there.
//
// Under « Ajusté, centré » only, a second switch (« Recadrage tardif »): a
// sheet whose list came in once the tap's flight had landed, leaving more map
// above it, keeps the territory where the flight put it ("rester", the
// default: one move per tap) or centres it there again by a second move
// ("recentrer"; sheetFit SheetLateMode, useSheetBand). Read at each decision.
import { ref } from "vue";
import {
  DEFAULT_SHEET_FIT,
  DEFAULT_SHEET_LATE,
  SHEET_FIT_MODES,
  SHEET_LATE_MODES,
  type SheetFitMode,
  type SheetLateMode,
} from "./sheetFit";

export type { SheetFitMode, SheetLateMode } from "./sheetFit";

const enabled = __TEST_TOOLS__;
const SHEET_FIT_KEY = "ac:sheet-fit";
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
export const sheetFitMode = ref<SheetFitMode>(
  __TEST_TOOLS__ ? stored(SHEET_FIT_KEY, SHEET_FIT_MODES, DEFAULT_SHEET_FIT) : DEFAULT_SHEET_FIT,
);

export function setSheetFitMode(m: SheetFitMode) {
  if (!enabled) return;
  sheetFitMode.value = m;
  try {
    localStorage.setItem(SHEET_FIT_KEY, m);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

// Read only in the builds with the testing tools, as the mode.
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
