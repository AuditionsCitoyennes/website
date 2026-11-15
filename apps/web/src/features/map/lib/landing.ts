// The moment a camera flight has landed (plateau/riseSwitch.ts,
// `ac:rise-order=after`: the plateau's rise waits for it). Pure: a map-like
// object and a clock, no mapbox import — run with `node --import tsx --test`
// (root "test:scripts").
//
// "Flying" is mapbox's `isEasing()`: an animated camera move (a flight, an
// ease, a fling's inertia), not a map held or dragged under a finger — that
// one never lands by itself and is not waited for.
//
// A `moveend` is not always a landing: starting a move ends the flight in the
// air, and mapbox reports that with a `moveend` fired from inside the call,
// before the new flight eases (useMapCamera.flyCamera tells the same story).
// So each `moveend` is checked one timer task later: still easing, the wait
// goes on. Events and plain timers only: no requestAnimationFrame, no loop.

/** What is read of a map (mapbox-gl's Map has it all). */
export interface LandingSource {
  isEasing(): boolean;
  on(type: "moveend", listener: () => void): unknown;
  off(type: "moveend", listener: () => void): unknown;
}

export interface LandingClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: LandingClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** How a wait ended: the camera landed, the cap ran out first, or the wait
 *  was cancelled (its caller superseded, the map gone). */
export type Landing = "landed" | "cap" | "cancelled";

/** Whether an animated camera move is in the air. A map that throws (removed)
 *  is not flying. */
export function isFlying(map: LandingSource | null | undefined): boolean {
  try {
    return !!map && map.isEasing();
  } catch {
    return false;
  }
}

/** Wait for `map`'s flight to land, `capMs` at most. `done` is called once,
 *  never synchronously; `cancel()` ends the wait with "cancelled" (a no-op
 *  once done). */
export function whenLanded(
  map: LandingSource,
  capMs: number,
  clock: LandingClock = realClock,
): { done: Promise<Landing>; cancel: () => void } {
  let end: (how: Landing) => void = () => {};
  const done = new Promise<Landing>((resolve) => {
    let settled = false;
    let check: unknown = null;
    const onMoveEnd = () => {
      // One check pending is enough: it reads the map as it is then.
      if (settled || check !== null) return;
      check = clock.setTimeout(() => {
        check = null;
        if (!isFlying(map)) end("landed");
      }, 0);
    };
    const cap = clock.setTimeout(() => end("cap"), capMs);
    end = (how) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(cap);
      if (check !== null) clock.clearTimeout(check);
      try {
        map.off("moveend", onMoveEnd);
      } catch {
        /* a removed map */
      }
      resolve(how);
    };
    try {
      map.on("moveend", onMoveEnd);
    } catch {
      end("cancelled");
      return;
    }
    // Already at rest: the same check as a `moveend`'s, so never synchronous.
    if (!isFlying(map)) onMoveEnd();
  });
  return { done, cancel: () => end("cancelled") };
}
