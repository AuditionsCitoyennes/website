// A plateau's wait for its unit's own outline file (useOutlineFiles'
// holdSelf): past `waitMs` without it, the unit is held out — its plateau
// rises on what it has — for the rest of the session, so a file that is slow
// by itself is waited for once.
//
// With the late files kept quiet (ac:late-files, nothing is aborted), the
// file of a unit the visitor has just left can still be on the network,
// sharing the link with this unit's. A wait that such a file crossed
// (`abandoned` at its start or its end, or one landed meanwhile:
// `abandonedDone`) goes on once, `extraMs` more; and if the unit is held out
// after that, it is for this visit only (`session` false): the slowness was
// not its file's. Pure: timers and reads injected (selfHold.test.ts).

export interface SelfHoldOptions {
  waitMs: number;
  /** How much longer a wait crossed by an abandoned file goes on, once. */
  extraMs: number;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** The unit's self is stored. */
  stored: (id: string) => boolean;
  /** A file asked for a unit since left is on the network, now. */
  abandoned: () => boolean;
  /** How many such files have landed so far. */
  abandonedDone: () => number;
  /** The wait is over without the self; `session`: remembered for the session. */
  onHeldOut: (id: string, session: boolean) => void;
}

export function createSelfHold(o: SelfHoldOptions) {
  const holding = new Set<string>();
  /** Starts the unit's wait (one at a time per unit). */
  function hold(id: string): void {
    if (holding.has(id)) return;
    holding.add(id);
    const done0 = o.abandonedDone();
    let crossed = o.abandoned();
    const end = (extended: boolean) => {
      if (o.stored(id)) {
        holding.delete(id); // in time: nothing given up
        return;
      }
      crossed ||= o.abandoned() || o.abandonedDone() !== done0;
      if (crossed && !extended) {
        o.setTimer(() => end(true), o.extraMs);
        return;
      }
      holding.delete(id);
      o.onHeldOut(id, !crossed);
    };
    o.setTimer(() => end(false), o.waitMs);
  }
  return { hold, holding: (id: string) => holding.has(id) };
}
