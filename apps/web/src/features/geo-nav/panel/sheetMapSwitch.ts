// What a phone's raised sheet does when the visitor uses the map, compared
// live (the Témoignages page's testing options menu, « Carte touchée »,
// temoignages/DevOptionsMenu.vue), in the builds with the testing tools —
// the dev server and staging (__TEST_TOOLS__, vite.config): "baisser" (the
// default) lowers it to its strip as the map moves under the visitor's
// fingers or a spot or a territory is tapped; "rien" leaves it raised, as
// before, but for an open lieu (sheetMap.ts). Read at each use of the map,
// so a choice applies at once, with no reload. Production keeps the
// default, which this ref never leaves there (no switch is drawn).
// Desktops have no sheet: the switch changes nothing there.
import { ref } from "vue";
import { DEFAULT_SHEET_MAP, SHEET_MAP_MODES, type SheetMapMode } from "./sheetMap";

export type { SheetMapMode } from "./sheetMap";

const enabled = __TEST_TOOLS__;
const SHEET_MAP_KEY = "ac:sheet-map";

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
export const sheetMapMode = ref<SheetMapMode>(
  __TEST_TOOLS__ ? stored(SHEET_MAP_KEY, SHEET_MAP_MODES, DEFAULT_SHEET_MAP) : DEFAULT_SHEET_MAP,
);

export function setSheetMapMode(m: SheetMapMode) {
  if (!enabled) return;
  sheetMapMode.value = m;
  try {
    localStorage.setItem(SHEET_MAP_KEY, m);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
