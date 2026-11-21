// How the map page comes back after a network failure (audit candidate C40):
// what failed for want of a network is asked again by itself — after
// RECOVER_DELAYS_MS (2, 5, 10, 20 then 30 s), then whenever the browser says
// it is back online or the page is shown again. That holds for the outline
// files' start (root.json and France's: the session does not give the
// outlines up for its rest), the tree of places and the lists. Meanwhile the
// panel says in plain French what is happening, with a button to try again at
// once. The map's own style, when its request fails, is asked again a few
// times with a growing pause, then the map's box says so with a button
// (features/map/lib/styleRecovery.ts).
//
// A release skew or a malformed file still ends the outlines' session:
// nothing a new attempt would change. No import: loadable under node
// (recover.test.ts).

/** The waits before each new attempt after a failure; past the last, only the
 *  browser's « online » or the page shown again bring one. */
export const RECOVER_DELAYS_MS: readonly number[] = [2000, 5000, 10_000, 20_000, 30_000];

/** The wait before attempt `n` (0-based) after a failure; null past the schedule. */
export function recoverDelay(n: number): number | null {
  return n >= 0 && n < RECOVER_DELAYS_MS.length ? RECOVER_DELAYS_MS[n] : null;
}
