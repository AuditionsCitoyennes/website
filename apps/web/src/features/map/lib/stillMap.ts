// Work that waits for a still map: `whenMapStill(job)` runs a job when the
// camera is not moving, no plateau is rising or sinking and no pointer is
// down on the map, so that it never lands inside a flight, a rise or a drag.
//
// - First in, first out, one job per turn: a turn is a timer task at least
//   TURN_GAP_MS after the map was last busy and after the job before it, so
//   two jobs never share a frame and the frame after a move keeps its room.
// - A job can be cancelled (the function `whenMapStill` returns).
// - `timeoutMs`: past it the job runs anyway, moving map or not, in a turn of
//   its own.
// - Plain timers and events only: no requestIdleCallback, no scheduler.yield
//   (Safari has neither), no requestAnimationFrame (it stops in a hidden tab,
//   a timer does not), no render loop.
//
// What it is told: the map (`attach`: its `movestart` / `moveend` and
// `isMoving()`, and the pointers pressed on its canvas container), the
// plateau's rise and sink (`plateauMotionBegin` / `plateauMotionEnd`, from
// usePlateau's animation) and anything else that must hold the jobs back
// (`hold()`, released by the function it returns). Without a map nothing
// moves: a job runs at the next turn.
//
// GeoDrillMap attaches its map to the one scheduler below (`stillMap`) and
// usePlateau reports its animation; no job is scheduled by anything yet. The
// testing tools read `busy()` (dev/motionProbes.ts). No import: loadable
// under node (stillMap.test.ts, with a fake map and a fake clock).

/** The least time between the map last being busy, or a job, and the next job:
 *  two frames at 60 Hz, one at 30. */
export const TURN_GAP_MS = 34;

/** What the scheduler reads of a map (mapbox-gl's Map has it all). */
export interface StillMapSource {
  isMoving(): boolean;
  on(type: "movestart" | "moveend", listener: () => void): unknown;
  off(type: "movestart" | "moveend", listener: () => void): unknown;
  getCanvasContainer?(): PointerTarget;
}

type PointerListener = (e: { pointerId?: number; isPrimary?: boolean }) => void;
/** Where pointer events are listened to (an element, the window). */
export interface PointerTarget {
  addEventListener(type: string, listener: PointerListener, options?: unknown): void;
  removeEventListener(type: string, listener: PointerListener, options?: unknown): void;
}

export interface StillClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface StillJobOptions {
  /** Past this (ms from now) the job runs anyway, moving map or not. */
  timeoutMs?: number;
}

/** What keeps the map from being still, now. */
export interface MapBusy {
  /** The camera moves (a flight, a drag, a zoom). */
  camera: boolean;
  /** A plateau rises or sinks, or a `hold()` is not released. */
  plateau: boolean;
  /** A pointer is down on the map. */
  pointer: boolean;
}

interface Job {
  run: () => void;
  timeout: unknown;
}

const realClock: StillClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface StillMapOptions {
  clock?: StillClock;
  /** A job that threw (default: console.error); the queue goes on. */
  onError?: (err: unknown) => void;
}

export function createStillMap(options: StillMapOptions = {}) {
  const clock = options.clock ?? realClock;
  const onError = options.onError ?? ((err: unknown) => console.error("[still-map] job", err));

  let map: StillMapSource | null = null;
  let surface: PointerTarget | null = null;
  let release: PointerTarget | null = null;
  /** The pointers down on the map, by id. */
  const pointers = new Set<number>();
  let plateauMoving = false;
  let holds = 0;
  const queue: Job[] = [];
  /** The pending turn's timer; when the map last went busy or still, and when
   *  a job last ended. */
  let turn: unknown = null;
  let changedAt = -Infinity;
  let jobAt = -Infinity;

  const busy = (): MapBusy => ({
    camera: !!map && map.isMoving(),
    plateau: plateauMoving || holds > 0,
    pointer: pointers.size > 0,
  });
  const still = () => {
    const b = busy();
    return !b.camera && !b.plateau && !b.pointer;
  };

  /** How long until a job may run: the gap after the last change and the last job. */
  const gapLeft = () => Math.max(changedAt, jobAt) + TURN_GAP_MS - clock.now();

  /** A turn asked for, if there is a job and none is pending: at the gap's end.
   *  Asked for on a busy map too: the turn then finds it busy and leaves the
   *  asking to the event that ends it (a `moveend` may be heard a moment
   *  before `isMoving()` turns false). */
  function schedule() {
    if (turn !== null || !queue.length) return;
    turn = clock.setTimeout(pump, Math.max(0, gapLeft()));
  }

  function runJob(job: Job) {
    if (job.timeout !== null) clock.clearTimeout(job.timeout);
    job.timeout = null;
    try {
      job.run();
    } catch (err) {
      onError(err);
    }
    jobAt = clock.now();
  }

  function pump() {
    turn = null;
    if (!queue.length) return;
    // Busy: the event that ends it asks for the next turn.
    if (!still()) return;
    // Early (a job's timeout ran one in between): the rest of the gap first.
    if (gapLeft() > 0) return schedule();
    runJob(queue.shift()!);
    schedule();
  }

  /** The map went busy, or stopped being: the gap restarts, the turn with it. */
  function touched() {
    changedAt = clock.now();
    if (turn !== null) {
      clock.clearTimeout(turn);
      turn = null;
    }
    schedule();
  }

  const onMove = () => touched();
  const onPointerDown: PointerListener = (e) => {
    // A primary pointer is the first one down: any id still held was lost.
    if (e.isPrimary !== false) pointers.clear();
    pointers.add(e.pointerId ?? 0);
    touched();
  };
  const onPointerUp: PointerListener = (e) => {
    if (!pointers.delete(e.pointerId ?? 0)) return;
    touched();
  };
  const onBlur: PointerListener = () => {
    if (!pointers.size) return;
    pointers.clear();
    touched();
  };

  /** The map to watch (one at a time: another replaces it). `targets`: where
   *  the presses and the releases are heard — the map's canvas container and
   *  the window unless given. */
  function attach(
    next: StillMapSource,
    targets?: { surface: PointerTarget; release: PointerTarget },
  ) {
    if (map) detach(map);
    map = next;
    map.on("movestart", onMove);
    map.on("moveend", onMove);
    surface = targets?.surface ?? next.getCanvasContainer?.() ?? null;
    release =
      targets?.release ??
      (typeof window === "undefined" ? null : (window as unknown as PointerTarget));
    surface?.addEventListener("pointerdown", onPointerDown, { passive: true });
    for (const type of ["pointerup", "pointercancel"]) {
      release?.addEventListener(type, onPointerUp, { passive: true, capture: true });
    }
    release?.addEventListener("blur", onBlur);
    touched();
  }

  /** The map let go (its unmount): the jobs waiting are dropped, not run — they
   *  were for that map. No-op for a map that is not the one attached. */
  function detach(from?: StillMapSource) {
    if (!map || (from && from !== map)) return;
    map.off("movestart", onMove);
    map.off("moveend", onMove);
    surface?.removeEventListener("pointerdown", onPointerDown, { passive: true });
    for (const type of ["pointerup", "pointercancel"]) {
      release?.removeEventListener(type, onPointerUp, { passive: true, capture: true });
    }
    release?.removeEventListener("blur", onBlur);
    map = null;
    surface = null;
    release = null;
    pointers.clear();
    plateauMoving = false;
    holds = 0;
    for (const job of queue.splice(0)) {
      if (job.timeout !== null) clock.clearTimeout(job.timeout);
    }
    if (turn !== null) clock.clearTimeout(turn);
    turn = null;
  }

  /** A plateau starts rising or sinking. */
  function plateauMotionBegin() {
    if (plateauMoving) return;
    plateauMoving = true;
    touched();
  }
  /** …and has stopped (reached its height, or was cut short). */
  function plateauMotionEnd() {
    if (!plateauMoving) return;
    plateauMoving = false;
    touched();
  }

  /** The jobs held back until the function returned is called (once counts):
   *  for a stretch that is neither a camera move nor a rise, a whole plateau
   *  transition for one. */
  function hold(): () => void {
    holds++;
    touched();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds = Math.max(0, holds - 1);
      touched();
    };
  }

  /** Run `job` when the map is still, after the jobs asked before it. Returns
   *  its cancellation (a no-op once the job has run). */
  function whenStill(run: () => void, opts: StillJobOptions = {}): () => void {
    const job: Job = { run, timeout: null };
    queue.push(job);
    const take = () => {
      const at = queue.indexOf(job);
      if (at === -1) return false;
      queue.splice(at, 1);
      return true;
    };
    if (opts.timeoutMs !== undefined) {
      const force = () => {
        job.timeout = null;
        if (!queue.includes(job)) return;
        // Never in the frame of the job before it: the rest of that gap first.
        const left = jobAt + TURN_GAP_MS - clock.now();
        if (left > 0) {
          job.timeout = clock.setTimeout(force, left);
          return;
        }
        take();
        // Its own turn: the pending one waits for its gap again.
        if (turn !== null) {
          clock.clearTimeout(turn);
          turn = null;
        }
        runJob(job);
        schedule();
      };
      job.timeout = clock.setTimeout(force, opts.timeoutMs);
    }
    schedule();
    return () => {
      if (!take()) return;
      if (job.timeout !== null) clock.clearTimeout(job.timeout);
      job.timeout = null;
    };
  }

  return {
    attach,
    detach,
    plateauMotionBegin,
    plateauMotionEnd,
    hold,
    whenStill,
    /** What keeps the map busy now. */
    busy,
    /** The camera at rest, no plateau moving, no pointer down. */
    still,
    /** The jobs waiting. */
    pending: () => queue.length,
  };
}

export type StillMap = ReturnType<typeof createStillMap>;

/** The page's one scheduler, for its one live map (GeoDrillMap attaches it). */
export const stillMap: StillMap = createStillMap();

/** Run `job` when the map is still (see the header); returns its cancellation. */
export const whenMapStill = (job: () => void, options?: StillJobOptions): (() => void) =>
  stillMap.whenStill(job, options);
