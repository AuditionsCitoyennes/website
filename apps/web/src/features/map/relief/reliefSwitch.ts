// How the plateau's relief (its DEM tiles, rendered in the page: the key and
// the tiles come from the relief worker, demClient.ts, handed to Mapbox through
// the map's transformRequest, demHook.ts, for an `ac-dem://<key>/{z}/{x}/{y}`
// template) is prefetched and handed back, compared live in the builds with
// the testing tools — the dev server and staging (__TEST_TOOLS__,
// vite.config), kept in localStorage like the plateau lid's mode
// (plateau/lidSwitch.ts).
//
// How a run prefetches the new slot's tiles (`ac:relief-prefetch`, the
// Témoignages page's DEV switch's "Préchargement" row):
//
// - "hillshade" (the default): as today — an invisible hillshade on the spare
//   slot makes mapbox fetch its tiles while the old plateau sinks.
// - "terrain0": no hillshade, so every run starts its tiles at the swap (the
//   rise plays on unloaded tiles). A run with nothing of ours standing makes the
//   new slot the root terrain at exaggeration 0 at once, but the swap follows it
//   in the same task: that only matters to a run superseded in between. The
//   quiet swap keeps the hillshade (its wait needs the tiles).
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_RELIEF_PREFETCH.
//
// How the page hands its answers back to Mapbox (measurement arms, kept
// in localStorage only: no row in the DEV switch):
//
// - `ac:relief-budget`: at most that many answers per animation frame, lowest
//   z first; 0 = each at once. The default is DEFAULT_RELIEF_BUDGET (below,
//   with its reason).
// - `ac:relief-budget-ground` = "budgeted" (the default) | "exempt": answers
//   that are the ground tile skip the budget. Not compared by the flip (no
//   phone exists; lead note 2026-11-05): kept as an arm for a later
//   real-device run.
// - `ac:relief-commit-hold`: ms a run with nothing standing holds its commit
//   after the registration (usePlateau, demClient `commitHold`); 0 = no hold.
//   The default is DEFAULT_RELIEF_COMMIT_HOLD_MS (below, with its reason).
//   The flip compared it with 0 in the iOS Simulator only (it did not lose);
//   kept as an arm for a later real-device run.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_RELIEF_BUDGET,
// DEFAULT_RELIEF_BUDGET_GROUND, DEFAULT_RELIEF_COMMIT_HOLD_MS.

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

/**
 * The budget of a build without the testing tools, and the arm's default: 0,
 * every answer at once. At 4 per frame, lowest z first, Lyon's ~130 answers
 * keep the canonical tiles back: the terrain stood flat ~0.9 s after the swap
 * (desktop medians: first tile 909 ms, all in 1,350 ms after it, against 0 and
 * -155 at 0; ARA all in 1,767 ms after against -818; relief-france-task).
 * Not settled on phones: on the phone profile 0's ARA TBT (median 1,684 ms)
 * was above serveur's (1,170) and 4-with-ground-exempt's (1,148), inside rule
 * L's band only after six rounds (it tripped at two); the flip's phone-profile
 * runs read 1,130 against serveur's 1,119. Real-phone timing is unmeasured (no
 * device, lead note 2026-11-05): the arms stay so a later run can compare it.
 */
export const DEFAULT_RELIEF_BUDGET = 0;

/** Answers handed back to Mapbox per animation frame (`ac:relief-budget`; 0 = at once). */
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

/** Whether ground answers skip the budget (`ac:relief-budget-ground`). */
export const reliefBudgetGround: ReliefBudgetGround = __TEST_TOOLS__
  ? storedReliefBudgetGround()
  : DEFAULT_RELIEF_BUDGET_GROUND;

/** Ms waited before each answer (`ac:relief-delay`, a measurement arm). */
export const reliefDelay: number = __TEST_TOOLS__ ? storedCount("ac:relief-delay", 0) : 0;

/**
 * How long a run with nothing standing holds its commit after the
 * registration, ms, in a build without the testing tools, and the arm's
 * default. A fixed delay from the registration's end, so a slow registration
 * (the boot run, a unit never registered) pays it in full on top. France after
 * Monde (headless, relief-france-task): a registration answered from the memo
 * commits in the click task, and every frame drawn before the lid shot's
 * readback (plateau/mapSnapshot.ts, `wait(60)` then `getImageData`) is GPU
 * work that readback waits for. Held 60 ms, the commit's timer (set as the
 * registration ends, 12-35 ms after the click) fired, in every G run, just
 * before the lid's settle timer (also 60 ms): the readback follows the swap at
 * once with no frame in between. A sweep of 30-120 ms shows no knife edge; from
 * 90 on the readback runs first and the rise waits behind it. Not the POST's
 * timing (the swap lands ~36 ms after serveur's): coupled to that lid
 * constant, measured only under SwiftShader, and a loaded host can still put
 * the readback first (one D4 run of four). That readback is
 * `ac:lid-check=pixels` since lid-readback; under the default "signaux" no
 * pixel is read, and whether the hold still helps is that PR's hold-0 arm.
 */
export const DEFAULT_RELIEF_COMMIT_HOLD_MS = 60;

/** The commit hold of a run with nothing standing (`ac:relief-commit-hold`, ms; 0 = none). */
export const reliefCommitHold: number = __TEST_TOOLS__
  ? storedCount("ac:relief-commit-hold", DEFAULT_RELIEF_COMMIT_HOLD_MS)
  : DEFAULT_RELIEF_COMMIT_HOLD_MS;

/** This page load's prefetch. */
export const reliefPrefetch: ReliefPrefetch = __TEST_TOOLS__
  ? storedReliefPrefetch()
  : DEFAULT_RELIEF_PREFETCH;

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
