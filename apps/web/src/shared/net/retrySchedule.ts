// When a page asks again for what failed (the map page's panel: the tree of
// places and the lists). The page tells it its state at each change — "failed"
// (something on screen could not be had), "busy" (something is on its way)
// or "ok" — and calls `now()` when the network may be back (the browser
// online again, the page shown again) or the visitor asks. A failure arms ONE
// timer, the schedule's next wait (`delay(n)`, null past it): when it fires on
// a page still failed, `retry` runs. "ok" starts the schedule over. Nothing
// runs between these moments: no polling. Pure: timers injected
// (retrySchedule.test.ts).

type Timer = unknown;
export type RetryState = "failed" | "busy" | "ok";

export function retrySchedule(o: {
  retry: () => void;
  delay: (n: number) => number | null;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
}) {
  let n = 0;
  let state: RetryState = "ok";
  let timer: Timer | undefined;

  function clear() {
    if (timer === undefined) return;
    o.clearTimer(timer);
    timer = undefined;
  }

  function arm() {
    if (timer !== undefined) return;
    const ms = o.delay(n);
    if (ms === null) return; // past the schedule: now() alone
    n++;
    timer = o.setTimer(() => {
      timer = undefined;
      if (state === "failed") o.retry();
    }, ms);
  }

  return {
    /** The page's state changed. */
    update(next: RetryState) {
      state = next;
      if (next === "failed") arm();
      else {
        clear();
        if (next === "ok") n = 0;
      }
    },
    /** The network may be back, or the visitor asks: on a failed page, an
     *  attempt now, the schedule from its start. */
    now() {
      if (state !== "failed") return;
      clear();
      n = 0;
      o.retry();
    },
    /** The page is gone. */
    stop: clear,
    /** For the tests: the next wait's index, a timer armed. */
    peek: () => ({ n, armed: timer !== undefined, state }),
  };
}
