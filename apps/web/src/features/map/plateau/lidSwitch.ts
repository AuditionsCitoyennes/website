// How the plateau's lid is captured, compared live in the builds with the
// testing tools — the dev server and staging (__TEST_TOOLS__, vite.config),
// kept in localStorage like the Témoignages page's data source
// (temoignages/dataSource.ts) and drawn as its DEV switch's "Couvercle" row:
//
// - "ecran" (the default): the budget from the screen (lidTier.ts) — a select
//   that flies the camera shot at the floor, every other shot sized from the
//   camera between the floor and the ceiling — and the hidden map warmed up
//   small and parked once idle.
// - "ancien": the lid as before — a 2048 floor and a 4096 ceiling, every shot
//   sized from the live camera, the hidden map kept at its last size.
// - "aucun": no lid at all — no capture, no hidden map; the plateau's top is
//   the draped terrain.
//
// Read once per page load: switching reloads the page (the hidden map is
// created at the main map's load). Production has neither key nor switch:
// DEFAULT_LID_MODE.

export type LidMode = "ecran" | "ancien" | "aucun";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_LID_MODE: LidMode = "ecran";

export const LID_MODES: readonly LidMode[] = ["ecran", "ancien", "aucun"];

function storedLidMode(): LidMode {
  try {
    const raw = localStorage.getItem("ac:lid");
    return (LID_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as LidMode)
      : DEFAULT_LID_MODE;
  } catch {
    return DEFAULT_LID_MODE;
  }
}

/** This page load's mode. */
export const lidMode: LidMode = __TEST_TOOLS__ ? storedLidMode() : DEFAULT_LID_MODE;

/** Another mode: kept, and the page loaded again with it. */
export function setLidMode(mode: LidMode) {
  if (!__TEST_TOOLS__ || mode === lidMode) return;
  try {
    localStorage.setItem("ac:lid", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}
