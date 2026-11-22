// When the Témoignages page's panel shows while the page loads, compared live
// (the testing options menu, temoignages/DevOptionsMenu.vue) in the builds
// with the testing tools — the dev server and staging (__TEST_TOOLS__,
// vite.config): "apres" (the default) — held out of sight under the boot
// curtain, so that only the loading placeholder shows, and coming in as the
// curtain leaves (panelBoot.ts) — or "tout-de-suite": on show from the page's
// first render, over the curtain, its list usable before the map is ready
// (as before). On a phone (the lowered sheet) and a desktop (the side panel)
// alike.
//
// Read once per page load: the choice only matters during a boot, so its
// setter loads the page again. Production has neither key nor switch:
// DEFAULT_PANEL_BOOT.
//
// Pure: loadable under node (devOptions.test.ts).
import { DEFAULT_PANEL_BOOT, PANEL_BOOT_MODES, type PanelBootMode } from "./panelBoot";

export type { PanelBootMode } from "./panelBoot";

const PANEL_BOOT_KEY = "ac:panel-boot";

/** The kept mode, else the default (garbage or blocked storage too). */
function storedPanelBoot(): PanelBootMode {
  try {
    const raw = localStorage.getItem(PANEL_BOOT_KEY);
    return (PANEL_BOOT_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as PanelBootMode)
      : DEFAULT_PANEL_BOOT;
  } catch {
    return DEFAULT_PANEL_BOOT;
  }
}

/** This page load's mode. */
export const panelBootMode: PanelBootMode = __TEST_TOOLS__ ? storedPanelBoot() : DEFAULT_PANEL_BOOT;

/** Another mode: kept, and the page loaded again with it. */
export function setPanelBootMode(mode: PanelBootMode) {
  if (!__TEST_TOOLS__ || mode === panelBootMode) return;
  try {
    localStorage.setItem(PANEL_BOOT_KEY, mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}
