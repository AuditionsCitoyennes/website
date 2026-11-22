// How tall a phone's raised sheet stands, compared live (the Témoignages
// page's testing options menu, temoignages/DevOptionsMenu.vue), in the builds
// with the testing tools — the dev server and staging (__TEST_TOOLS__,
// vite.config): "ajuste" (the default) — as tall as its head and its content
// need, up to the full panel (sheetFit.ts) —, "centre": the same, and an open
// lieu's pin aimed into the map left above a short sheet (sheetFit
// lieuAimPx, usePanelLayout's camera padding) — or "plein": always the full
// panel, as before. Read by useBottomSheet at each measure and by the camera's
// padding, so a choice applies at once, with no reload. Production keeps the default, which this
// ref never leaves there (no switch is drawn). Desktops have no sheet: the
// switch changes nothing there.
import { ref } from "vue";
import { DEFAULT_SHEET_FIT, SHEET_FIT_MODES, type SheetFitMode } from "./sheetFit";

export type { SheetFitMode } from "./sheetFit";

const enabled = __TEST_TOOLS__;
const SHEET_FIT_KEY = "ac:sheet-fit";

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
