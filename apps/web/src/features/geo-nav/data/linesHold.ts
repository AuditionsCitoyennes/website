// A tapped unit's wait for its bundle (its children's boundaries:
// useOutlineFiles' holdLines): one timer for the visit, `ms` long and never
// longer — past it the unit's plateau rises without them, and they join
// later. Unlike the wait for a unit's own file (selfHold.ts) it does not go
// on when another unit's file shares the link: the rise is never held past
// the wait asked for. Leaving the unit ends its wait, so a unit tapped again
// gets a whole one. A wait of 0 gives up at once, in the caller's own task.
// Pure: timers and reads injected (linesHold.test.ts).

export interface LinesHoldOptions {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** The unit's bundle is in, or will not come (failed). */
  settled: (id: string) => boolean;
  /** The wait is over without the bundle. */
  onOut: (id: string) => void;
}

export function createLinesHold(o: LinesHoldOptions) {
  const timers = new Map<string, unknown>();
  /** Starts the unit's wait (one at a time per unit). */
  function hold(id: string, ms: number): void {
    if (timers.has(id)) return;
    if (!(ms > 0)) {
      if (!o.settled(id)) o.onOut(id);
      return;
    }
    timers.set(
      id,
      o.setTimer(() => {
        timers.delete(id);
        if (!o.settled(id)) o.onOut(id);
      }, ms),
    );
  }
  /** The unit is left: its wait ends, nothing given up. */
  function leave(id: string): void {
    if (!timers.has(id)) return;
    o.clearTimer(timers.get(id));
    timers.delete(id);
  }
  return { hold, leave, holding: (id: string) => timers.has(id) };
}
