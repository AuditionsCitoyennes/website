// When the decorative outline files come — the world outlines of the tree's
// countries (geo's globeBatch) and, at a country, its neighbours' own outlines
// (siblingSelves): thin lines around other countries, on which no plateau
// stands. They wait for the map's first plateau to stand
// (map/lib/plateauStood.ts), or DECOR_CAP_MS after the boot curtain lifted if
// no plateau stands by then, so they never share the link with what the first
// plateau needs; at the world's scope (Monde) they are the map's content and
// never wait. They are then asked at low fetch priority, at most
// DECOR_PARALLEL at a time — each file's give-up timer starts when its own
// request starts, never while it waits its turn — and written to the store at
// a moment the map is still (map/lib/stillMap.ts), at most DECOR_APPLY_MS
// later. No import: loadable under node (outlinesDecorSwitch.test.ts).

/** With no plateau standing, the decorative files come this long after the
 *  boot curtain lifted anyway (a scope with no plateau, a slow device). */
export const DECOR_CAP_MS = 8000;

/** At most this many decorative files requested at once. */
export const DECOR_PARALLEL = 4;

/** A decorative batch waits at most this long for a still map before its
 *  write (the still-map scheduler's own cap). */
export const DECOR_APPLY_MS = 3000;

/** Past this the write happens even if the scheduler dropped the job (its
 *  map was let go: the jobs waiting are dropped, not run). */
export const DECOR_APPLY_BACKSTOP_MS = DECOR_APPLY_MS + 1000;

/** The decorative files may be asked now: at the world's scope, once a
 *  plateau stood, or once the cap passed. (The boot curtain holds them too:
 *  useMapFeed.) */
export function decorOpen(o: {
  level: string;
  plateauStood: boolean;
  capPassed: boolean;
}): boolean {
  return o.level === "world" || o.plateauStood || o.capPassed;
}

type Timer = unknown;

/** How a decorative batch's write is applied: handed to
 *  `whenStill` (the still-map scheduler, capped at DECOR_APPLY_MS), with a
 *  backstop timer in case the scheduler drops the job; the write runs once. */
export function stillApply(deps: {
  whenStill: (job: () => void, opts: { timeoutMs: number }) => () => void;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
}): (write: () => void) => void {
  return (write) => {
    let done = false;
    let cancel: () => void = () => {};
    let backstop: Timer = null;
    const run = () => {
      if (done) return;
      done = true;
      deps.clearTimer(backstop);
      cancel();
      write();
    };
    backstop = deps.setTimer(run, DECOR_APPLY_BACKSTOP_MS);
    cancel = deps.whenStill(run, { timeoutMs: DECOR_APPLY_MS });
  };
}
