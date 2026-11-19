// A tapped unit's wait for its bundle (its children's boundaries:
// useOutlineFiles' holdLines): one timer for the visit, `ms` long and never
// longer — past it the unit's plateau rises without them, and they join
// later. Unlike the wait for a unit's own file (selfHold.ts) it does not go
// on when another unit's file shares the link: the rise is never held past
// the wait asked for. Once its time has passed the wait is `over` for the
// rest of the visit, whatever the bundle's state was then (in, failed or
// still coming): a bundle that failed and is asked again later does not
// reopen it. Leaving the unit ends its wait, so a unit tapped again gets a
// whole one. A wait of 0 is over at once, in the caller's own task.
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
  /** The units whose wait has run its time, until they are left. */
  const done = new Set<string>();
  const end = (id: string) => {
    done.add(id);
    if (!o.settled(id)) o.onOut(id);
  };
  /** Starts the unit's wait (one per visit of the unit). */
  function hold(id: string, ms: number): void {
    if (timers.has(id) || done.has(id)) return;
    if (!(ms > 0)) {
      end(id);
      return;
    }
    timers.set(
      id,
      o.setTimer(() => {
        timers.delete(id);
        end(id);
      }, ms),
    );
  }
  /** The unit is left: its wait ends, nothing given up. */
  function leave(id: string): void {
    done.delete(id);
    if (!timers.has(id)) return;
    o.clearTimer(timers.get(id));
    timers.delete(id);
  }
  return {
    hold,
    leave,
    holding: (id: string) => timers.has(id),
    /** The unit's wait has run its time: nothing waits for its bundle any
     *  more, even one asked again after it failed. */
    over: (id: string) => done.has(id),
  };
}
