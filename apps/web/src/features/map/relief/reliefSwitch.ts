// Where the plateau's relief (its DEM tiles) is rendered, compared live in the
// builds with the testing tools — the dev server and staging (__TEST_TOOLS__,
// vite.config), kept in localStorage like the plateau lid's mode
// (plateau/lidSwitch.ts) and drawn as the Témoignages page's DEV switch's
// "Relief" row:
//
// - "serveur" (the default): the API renders them — POST /api/dem for the
//   version key, then Mapbox fetches the tiles from /api/dem/<key>/z/x/y.
// - "client": the page renders them — the key and the tiles come from the
//   relief worker (demClient.ts), handed to Mapbox through the map's
//   transformRequest (demHook.ts) for an `ac-dem://<key>/{z}/{x}/{y}`
//   template; no request at all.
//
// Read once per page load: switching reloads the page (transformRequest is a
// Map constructor option, installed only in a page loaded in "client").
// Production has neither key nor switch: DEFAULT_RELIEF_MODE.
//
// The session's route (`reliefRoute`) starts at the mode and changes once at
// most: a "client" page whose client failed (demoteRelief) takes "serveur" for
// the rest of the session.
//
// How a "client" run prefetches the new slot's tiles (`ac:relief-prefetch`, the
// "Préchargement" row, shown under "Client" only):
//
// - "hillshade" (the default): as today — an invisible hillshade on the spare
//   slot makes mapbox fetch its tiles while the old plateau sinks.
// - "terrain0": no hillshade, so every run starts its tiles at the swap (the
//   rise plays on unloaded tiles). A run with nothing of ours standing makes the
//   new slot the root terrain at exaggeration 0 at once, but the swap follows it
//   in the same task: that only matters to a run superseded in between. The
//   quiet swap keeps the hillshade (its wait needs the tiles).
//
// It acts only on a run whose route is "client"; inert under "serveur". Read
// once per page load: switching reloads the page. Production has neither key
// nor switch: DEFAULT_RELIEF_PREFETCH.
//
// How a "client" page hands its answers back to Mapbox (measurement arms, kept
// in localStorage only: no row in the DEV switch):
//
// - `ac:relief-budget`: at most that many answers per animation frame, lowest
//   z first; 0 = each at once. The default is DEFAULT_RELIEF_BUDGET (below,
//   with its reason).
// - `ac:relief-budget-ground` = "budgeted" (the default) | "exempt": answers
//   that are the ground tile skip the budget. Kept as an arm so the phone runs
//   of the flip can still compare it.
//
// They act only on a page loaded in "client". Read once per page load.
// Production has neither key nor switch: DEFAULT_RELIEF_BUDGET,
// DEFAULT_RELIEF_BUDGET_GROUND.

export type ReliefMode = "serveur" | "client";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_RELIEF_MODE: ReliefMode = "serveur";

export const RELIEF_MODES: readonly ReliefMode[] = ["serveur", "client"];

function storedReliefMode(): ReliefMode {
  try {
    const raw = localStorage.getItem("ac:relief");
    return (RELIEF_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as ReliefMode)
      : DEFAULT_RELIEF_MODE;
  } catch {
    return DEFAULT_RELIEF_MODE;
  }
}

export type ReliefPrefetch = "hillshade" | "terrain0";

/** The prefetch of a build without the testing tools, and the switch's default. */
export const DEFAULT_RELIEF_PREFETCH: ReliefPrefetch = "hillshade";

export const RELIEF_PREFETCHES: readonly ReliefPrefetch[] = ["hillshade", "terrain0"];

/** The kept prefetch, else the default (garbage or blocked storage too). */
export function storedReliefPrefetch(): ReliefPrefetch {
  try {
    const raw = localStorage.getItem("ac:relief-prefetch");
    return (RELIEF_PREFETCHES as readonly string[]).includes(raw ?? "")
      ? (raw as ReliefPrefetch)
      : DEFAULT_RELIEF_PREFETCH;
  } catch {
    return DEFAULT_RELIEF_PREFETCH;
  }
}

/** A whole number ≥ 0 kept under `key`, else `fallback`. */
function storedCount(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null || raw === "" ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** This page load's mode. */
export const reliefMode: ReliefMode = __TEST_TOOLS__ ? storedReliefMode() : DEFAULT_RELIEF_MODE;

/**
 * The budget of a build without the testing tools, and the arm's default: 0,
 * every answer at once. At 4 per frame, lowest z first, Lyon's ~130 answers
 * keep the canonical tiles back: the terrain stood flat ~0.9 s after the swap
 * (desktop medians: first tile 909 ms, all in 1,350 ms after it, against 0 and
 * -155 at 0; ARA all in 1,767 ms after against -818; relief-france-task).
 */
export const DEFAULT_RELIEF_BUDGET = 0;

/** "client": answers handed back to Mapbox per animation frame (`ac:relief-budget`; 0 = at once). */
export const reliefBudget: number = __TEST_TOOLS__
  ? storedCount("ac:relief-budget", DEFAULT_RELIEF_BUDGET)
  : DEFAULT_RELIEF_BUDGET;

export type ReliefBudgetGround = "budgeted" | "exempt";

/** Whether ground answers take the budget in a build without the testing tools, and the arm's default. */
export const DEFAULT_RELIEF_BUDGET_GROUND: ReliefBudgetGround = "budgeted";

export const RELIEF_BUDGET_GROUNDS: readonly ReliefBudgetGround[] = ["budgeted", "exempt"];

/** The kept ground arm, else the default (garbage or blocked storage too). */
export function storedReliefBudgetGround(): ReliefBudgetGround {
  try {
    const raw = localStorage.getItem("ac:relief-budget-ground");
    return (RELIEF_BUDGET_GROUNDS as readonly string[]).includes(raw ?? "")
      ? (raw as ReliefBudgetGround)
      : DEFAULT_RELIEF_BUDGET_GROUND;
  } catch {
    return DEFAULT_RELIEF_BUDGET_GROUND;
  }
}

/** "client": whether ground answers skip the budget (`ac:relief-budget-ground`). */
export const reliefBudgetGround: ReliefBudgetGround = __TEST_TOOLS__
  ? storedReliefBudgetGround()
  : DEFAULT_RELIEF_BUDGET_GROUND;

/** "client": ms waited before each answer (`ac:relief-delay`, a measurement arm). */
export const reliefDelay: number = __TEST_TOOLS__ ? storedCount("ac:relief-delay", 0) : 0;

/** This page load's prefetch (a "client" run's only). */
export const reliefPrefetch: ReliefPrefetch = __TEST_TOOLS__
  ? storedReliefPrefetch()
  : DEFAULT_RELIEF_PREFETCH;

/** Another mode: kept, and the page loaded again with it. */
export function setReliefMode(mode: ReliefMode) {
  if (!__TEST_TOOLS__ || mode === reliefMode) return;
  try {
    localStorage.setItem("ac:relief", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** Another prefetch: kept, and the page loaded again with it. */
export function setReliefPrefetch(prefetch: ReliefPrefetch) {
  if (!__TEST_TOOLS__ || prefetch === reliefPrefetch) return;
  try {
    localStorage.setItem("ac:relief-prefetch", prefetch);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

let route: ReliefMode = reliefMode;

/** The route this session's plateaus take now: the mode, or "serveur" once demoted. */
export function reliefRoute(): ReliefMode {
  return route;
}

/** The client failed (`reason`): "serveur" for the rest of the session. */
export function demoteRelief(reason: string) {
  if (route === "serveur") return;
  route = "serveur";
  if (__TEST_TOOLS__) console.warn(`[relief] client lost (${reason}): serveur from now on`);
}
