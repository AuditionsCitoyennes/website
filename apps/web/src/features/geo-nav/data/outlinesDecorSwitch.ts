// When the decorative outline files come — the world outlines of the tree's
// countries (geo's globeBatch) and, at a country, its neighbours' own outlines
// (siblingSelves): thin lines around other countries, on which no plateau
// stands — compared live in the builds with the testing tools (the dev server
// and staging, __TEST_TOOLS__), kept in localStorage like the plateau lid's
// mode (map/plateau/lidSwitch.ts) and drawn as the DEV dialog's « Contours
// voisins » row:
//
// - "after" (the default): they wait for the map's first plateau to stand
//   (map/lib/plateauStood.ts), or DECOR_CAP_MS after the boot curtain lifted
//   if no plateau stands by then, so they never share the link with what the
//   first plateau needs; at the world's scope (Monde) they are the map's
//   content and never wait. They are then asked at low fetch priority, at
//   most DECOR_PARALLEL at a time — each file's give-up timer starts when its
//   own request starts, never while it waits its turn — and written to the
//   store at a moment the map is still (map/lib/stillMap.ts), at most
//   DECOR_APPLY_MS later.
// - "boot": as before — asked all at once as the boot curtain lifts, at the
//   default priority, written as soon as they are in.
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_OUTLINES_DECOR. No import: loadable under node
// (outlinesDecorSwitch.test.ts).

export type OutlinesDecor = "after" | "boot";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_OUTLINES_DECOR: OutlinesDecor = "after";

export const OUTLINES_DECORS: readonly OutlinesDecor[] = ["after", "boot"];

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

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedOutlinesDecor(): OutlinesDecor {
  try {
    const raw = localStorage.getItem("ac:outlines-decor");
    return (OUTLINES_DECORS as readonly string[]).includes(raw ?? "")
      ? (raw as OutlinesDecor)
      : DEFAULT_OUTLINES_DECOR;
  } catch {
    return DEFAULT_OUTLINES_DECOR;
  }
}

/** This page load's mode. */
export const outlinesDecor: OutlinesDecor = __TEST_TOOLS__
  ? storedOutlinesDecor()
  : DEFAULT_OUTLINES_DECOR;

/** Another mode: kept, and the page loaded again with it. */
export function setOutlinesDecor(mode: OutlinesDecor) {
  if (!__TEST_TOOLS__ || mode === outlinesDecor) return;
  try {
    localStorage.setItem("ac:outlines-decor", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** The decorative files may be asked now: always under "boot"; under "after"
 *  at the world's scope, once a plateau stood, or once the cap passed. (The
 *  boot curtain holds them in both modes, as before: useMapFeed.) */
export function decorOpen(o: {
  mode: OutlinesDecor;
  level: string;
  plateauStood: boolean;
  capPassed: boolean;
}): boolean {
  return o.mode === "boot" || o.level === "world" || o.plateauStood || o.capPassed;
}

type Timer = unknown;

/** How a decorative batch's write is applied under "after": handed to
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
