// What a committed plateau's rise waits for before it starts: a gate of a few
// milliseconds (the pending mark's violet leaving the unit first: gl/
// PendingMarkPass, `gateMs`) and, with `ac:rise-order=after`, the camera's
// landing (lib/landing.ts). One wait at a time, the PLATEAU's and not its
// run's: a later run for the same unit that comes to its own rise takes the
// wait over (`wait` again, or `take`), and the run that held it stops without
// a word; the plateau going (another unit, a clear, a failure, the unmount)
// drops it. Pure: timers only, never a frame — a blocked main thread delays
// the gate by the block and by nothing more. Run with
// `node --import tsx --test` (root "test:scripts").

export interface RiseClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: RiseClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** How a wait ended: the rise may start; the plateau went ("dropped"); a
 *  later run for the same plateau took the wait over ("taken"). */
export type RiseStart = "start" | "dropped" | "taken";

/** Something else the rise waits for (the camera's landing): `done` settles
 *  when it is over, `cancel` ends it early. */
export interface RiseAlso {
  done: Promise<unknown>;
  cancel(): void;
}

export function createRiseHold(clock: RiseClock = realClock) {
  let current: { scope: string; end: (how: RiseStart) => void } | null = null;

  /**
   * Wait `gateMs` (a timer: 0 still takes a task, never synchronous) and for
   * `also`, for the plateau of `scope`. Resolves "start" once both are over,
   * "dropped" or "taken" as soon as the wait is dropped or taken over (the
   * timer cleared, `also` cancelled). A wait under way is taken over.
   */
  function wait(scope: string, gateMs: number, also?: RiseAlso): Promise<RiseStart> {
    current?.end("taken");
    return new Promise<RiseStart>((resolve) => {
      let over = false;
      let gate = false;
      let other = !also;
      const end = (how: RiseStart) => {
        if (over) return;
        over = true;
        clock.clearTimeout(timer);
        if (how !== "start") also?.cancel();
        if (current === mine) current = null;
        resolve(how);
      };
      const mine = { scope, end };
      const check = () => {
        if (gate && other) end("start");
      };
      const timer = clock.setTimeout(
        () => {
          gate = true;
          check();
        },
        Math.max(0, gateMs),
      );
      current = mine;
      void also?.done.then(
        () => {
          other = true;
          check();
        },
        () => {
          other = true;
          check();
        },
      );
    });
  }

  return {
    wait,
    /** The plateau goes: the wait under way ends "dropped". */
    drop: () => current?.end("dropped"),
    /** A run rises the plateau now: the wait under way ends "taken". */
    take: () => current?.end("taken"),
    /** The unit whose rise waits, "" when none. */
    waiting: () => current?.scope ?? "",
  };
}

export type RiseHold = ReturnType<typeof createRiseHold>;
