// How the map page comes back after a network failure (audit candidate C40),
// compared live in the builds with the testing tools (the dev server and
// staging, __TEST_TOOLS__), kept in localStorage and drawn as the DEV
// dialog's « Reprise après coupure » row:
//
// - "auto" (the default): what failed for want of a network is asked again
//   by itself — after RECOVER_DELAYS_MS (2, 5, 10, 20 then 30 s), then
//   whenever the browser says it is back online or the page is shown again.
//   That holds for the outline files' start (root.json and France's: the
//   session no longer gives the outlines up for its rest), the tree of
//   places and the lists. Meanwhile the panel says in plain French what is
//   happening, with a button to try again at once.
// - "ancien": as before — the outlines are given up for the session after
//   their start failed, and the tree and the lists are asked again only when
//   the visitor moves to another place.
//
// A release skew or a malformed file still ends the outlines' session in both
// modes: nothing a new attempt would change.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_RECOVER. No import: loadable under node
// (recoverSwitch.test.ts).

export type Recover = "auto" | "ancien";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_RECOVER: Recover = "auto";

export const RECOVERS: readonly Recover[] = ["auto", "ancien"];

/** The waits before each new attempt after a failure; past the last, only the
 *  browser's « online » or the page shown again bring one. */
export const RECOVER_DELAYS_MS: readonly number[] = [2000, 5000, 10_000, 20_000, 30_000];

/** The wait before attempt `n` (0-based) after a failure; null past the schedule. */
export function recoverDelay(n: number): number | null {
  return n >= 0 && n < RECOVER_DELAYS_MS.length ? RECOVER_DELAYS_MS[n] : null;
}

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedRecover(): Recover {
  try {
    const raw = localStorage.getItem("ac:recover");
    return (RECOVERS as readonly string[]).includes(raw ?? "") ? (raw as Recover) : DEFAULT_RECOVER;
  } catch {
    return DEFAULT_RECOVER;
  }
}

/** This page load's mode. */
export const recover: Recover = __TEST_TOOLS__ ? storedRecover() : DEFAULT_RECOVER;

/** Another mode: kept, and the page loaded again with it. */
export function setRecover(mode: Recover) {
  if (!__TEST_TOOLS__ || mode === recover) return;
  try {
    localStorage.setItem("ac:recover", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}
