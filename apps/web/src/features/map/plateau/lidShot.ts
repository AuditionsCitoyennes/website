// The end of a lid shot (mapSnapshot.ts `shoot`), after the hidden map's camera
// jump: wait for the map to be ready, let it settle, grab the canvas, judge the
// grab. Pure — the manager hands in the map, its signals and its timers — so
// the judgement is tested with a fake map (lidShot.test.ts).
//
// What blanks a captured WebGL frame is a drawing buffer that was never drawn,
// or was cleared since it was: a lost context (the canvas reads transparent
// until it is restored and drawn again), a canvas resized with no render since
// (the resize clears it), a grab before any render. "signaux" counts those
// from the map's own events (render, resize, webglcontextlost/restored) plus
// one synchronous read, isContextLost(): the canvas's loss event is queued as
// a task, so it lands after the loss. No pixel is read. loaded() read from a
// timer after a jumpTo already implies a frame rendered since the jump with
// every tile loaded (the jump marks the sources dirty, the next render clears
// them), so the shot is the frame it was before.
//
// The one frame the signals pass that the pixels would not is a map whose
// tiles failed (network, quota): loaded() (errored tiles count as done), drawn,
// and a plain background. A shot with a map error since its jump still gets
// the 8×8 readback on the main thread. "pixels" is the shot before
// lid-readback: every grab is read back, a uniform one rejected.

export type ShotEnd = "ok" | "superseded" | "timeout" | "lost" | "undrawn" | "blank" | "failed";

export interface ShotMap {
  loaded(): boolean;
}

/** The hidden map's counters, kept by the manager's listeners. */
export interface ShotSignals {
  /** `render` events so far. */
  renders: number;
  /** `renders` at the last resize or context restore: the buffer was cleared then. */
  clearedAt: number;
  /** Between `webglcontextlost` and `webglcontextrestored`. */
  lost: boolean;
  /** `error` events so far. */
  errors: number;
}

export interface ShotIO<B> {
  map: ShotMap;
  /** The live object the manager's listeners update. */
  signals: ShotSignals;
  /** The hidden map exists (the manager's ready condition before lid-readback). */
  alive(): boolean;
  /** This shot is still the newest and the hidden map exists. */
  current(): boolean;
  /** The hidden canvas's context is lost now (read synchronously). */
  glLost(): boolean;
  frame(): Promise<void>;
  wait(ms: number): Promise<void>;
  until(cond: () => boolean, ms: number): Promise<boolean>;
  /** Copy the canvas (createImageBitmap). */
  grab(): Promise<B>;
  close(b: B): void;
  /** The 8×8 readback: true when the grab looks uniform. */
  blank(b: B): boolean;
}

/** Small raster/label settle margin between ready and the grab. A "client"
 *  run's commit hold is timed against this wait (relief/reliefSwitch.ts
 *  DEFAULT_RELIEF_COMMIT_HOLD_MS): change one, measure both. */
export const SETTLE_MS = 60;
export const READY_TIMEOUT_MS = 12000;

/** Ends `ok` with the bitmap, or without one: every other end closed what it grabbed. */
export interface Shot<B> {
  end: ShotEnd;
  bitmap?: B;
}

/**
 * "signaux": wait, settle and grab, judged on the signals. `at` is the signals
 * read right after the jump. A grab that rejects ends `failed`.
 */
export async function settleAndGrab<B>(
  io: ShotIO<B>,
  at: { renders: number; errors: number },
): Promise<Shot<B>> {
  const s = io.signals;
  const lost = () => s.lost || io.glLost();
  const drawn = () => !lost() && s.renders > Math.max(at.renders, s.clearedAt);
  await io.frame();
  // A superseded shot ends at the next poll (its `at` is stale), so it never
  // holds the manager's `shooting` count past the newer shot's ready.
  const ok = await io.until(() => !io.current() || (io.map.loaded() && drawn()), READY_TIMEOUT_MS);
  if (!io.current()) return { end: "superseded" };
  if (!ok) return { end: "timeout" };
  await io.wait(SETTLE_MS);
  if (!io.current()) return { end: "superseded" };
  if (lost()) return { end: "lost" };
  if (!drawn()) return { end: "undrawn" };
  let b: B;
  try {
    b = await io.grab();
  } catch {
    return { end: "failed" };
  }
  if (!io.current()) {
    io.close(b);
    return { end: "superseded" };
  }
  // A loss flagged while the copy was being taken. A resize after the call
  // does not touch the copy.
  if (lost()) {
    io.close(b);
    return { end: "lost" };
  }
  return s.errors > at.errors ? judged(io, b) : { end: "ok", bitmap: b };
}

/**
 * "pixels": the shot as it was before lid-readback, await for await — ready
 * on loaded() alone, every grab read back, a grab that rejects propagating.
 */
export async function settleAndGrabPixels<B>(io: ShotIO<B>): Promise<Shot<B>> {
  await io.frame();
  const ok = await io.until(() => io.alive() && io.map.loaded(), READY_TIMEOUT_MS);
  if (!io.current()) return { end: "superseded" };
  if (!ok) return { end: "timeout" };
  await io.wait(SETTLE_MS);
  if (!io.current()) return { end: "superseded" };
  const b = await io.grab();
  if (!io.current()) {
    io.close(b);
    return { end: "superseded" };
  }
  return judged(io, b);
}

/** The 8×8 readback's verdict on a grab. */
function judged<B>(io: ShotIO<B>, b: B): Shot<B> {
  if (!io.blank(b)) return { end: "ok", bitmap: b };
  io.close(b);
  return { end: "blank" };
}

/** RGBA pixels whose luminance spans less than 4: a uniform (blank/black) frame. */
export function uniformSample(d: ArrayLike<number>): boolean {
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  return max - min < 4;
}
