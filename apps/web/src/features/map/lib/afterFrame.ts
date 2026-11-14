// A job put off until the next frame has been drawn: `schedule(job)` runs it
// in a task of its own after that frame's callbacks and its paint, so the
// frame that answers the visitor's act does not carry it (the pins' rebuild:
// ac:pins-rebuild, ../threadSwitch.ts).
//
// - One job at a time: scheduling again replaces the job and keeps the turn
//   already asked for, so a burst of changes runs the last one once.
// - Where frames have stopped (a hidden tab) the job runs anyway, after
//   AFTER_FRAME_CAP_MS.
// - `flush()` runs it now, `cancel()` drops it.
// - One requestAnimationFrame per job, none while nothing waits: no loop.
//
// No import: loadable under node (afterFrame.test.ts, with a fake clock).

/** Without a frame for this long the job runs anyway (ms). */
export const AFTER_FRAME_CAP_MS = 250;

export interface FrameClock {
  requestAnimationFrame(fn: () => void): number;
  cancelAnimationFrame(id: number): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: FrameClock = {
  requestAnimationFrame: (fn) => requestAnimationFrame(fn),
  cancelAnimationFrame: (id) => cancelAnimationFrame(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function createAfterFrame(clock: FrameClock = realClock) {
  let job: (() => void) | null = null;
  let frame = 0;
  let task: unknown = null;
  let cap: unknown = null;

  function clear() {
    job = null;
    if (frame) clock.cancelAnimationFrame(frame);
    if (task !== null) clock.clearTimeout(task);
    if (cap !== null) clock.clearTimeout(cap);
    frame = 0;
    task = null;
    cap = null;
  }

  function run() {
    const mine = job;
    clear();
    mine?.();
  }

  return {
    /** `fn` after the next frame is drawn; replaces a job still waiting. */
    schedule(fn: () => void) {
      const waiting = job !== null;
      job = fn;
      if (waiting) return;
      frame = clock.requestAnimationFrame(() => {
        frame = 0;
        // After this frame's callbacks and its paint: a task of its own.
        task = clock.setTimeout(run, 0);
      });
      cap = clock.setTimeout(run, AFTER_FRAME_CAP_MS);
    },
    /** The job waiting, run now. */
    flush() {
      if (job) run();
    },
    /** The job waiting, dropped. */
    cancel: clear,
    /** Whether a job waits. */
    pending: () => job !== null,
  };
}

export type AfterFrame = ReturnType<typeof createAfterFrame>;
