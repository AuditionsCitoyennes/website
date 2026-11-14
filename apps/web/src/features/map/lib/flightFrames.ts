// The frames of one camera flight, timed for the device's tier
// (shared/device/deviceTier `reportFrameTimes`): how long after the frame
// before it each frame was drawn, and how much of that the page's thread
// worked. The second number tells which part is slow: frames late while the
// thread worked are a slow processor; frames late while it sat free are slow
// graphics.
//
// The thread's work is read from pings: a zero-delay timer chained on itself
// for the length of the flight. A free thread answers each within a few
// milliseconds (browsers hold a chained timer about 4 ms); a ping that comes
// later than that found the thread busy since its timer was due — with the
// map's own frame, a tile being parsed, the page's updates, anything. A
// browser that holds its timers longer only reads as busier, which errs
// towards the processor (the tier's reading of an unknown).
//
// Pure: no DOM, no timer, no Vue; the caller (composables/useFlightMeasure)
// gives every time. Run with `node --import tsx --test` (root "test:scripts").
import type { FrameSample } from "../../../shared/device/deviceTier";

/** How long a browser holds a chained zero-delay timer (ms). */
export const PING_HOLD_MS = 4;
/** A ping answered within this of the one before found the thread free. */
export const FREE_PING_MS = 2 * PING_HOLD_MS;
/** A flight is recorded up to these; past either it is too long to judge. */
export const MAX_FLIGHT_FRAMES = 600;
export const MAX_FLIGHT_PINGS = 4000;

/**
 * The time the page's thread worked between `from` and `to`, read from the
 * pings (`pings`: ascending times; the first is the chain's start, the last
 * may be the moment of reading, which closes the wait in progress). Between
 * two pings further apart than FREE_PING_MS the thread worked from the
 * moment the second was due (PING_HOLD_MS after the first) until it came.
 */
export function threadWork(pings: readonly number[], from: number, to: number): number {
  let work = 0;
  for (let i = 1; i < pings.length; i++) {
    const a = pings[i - 1];
    const b = pings[i];
    if (b <= from) continue;
    if (a >= to) break;
    if (b - a <= FREE_PING_MS) continue;
    work += Math.max(0, Math.min(b, to) - Math.max(a + PING_HOLD_MS, from));
  }
  return work;
}

export interface FlightFrames {
  /** The thread answered a ping. */
  ping(now: number): void;
  /** A frame of the flight was drawn. */
  frame(now: number): void;
  /** Past a limit: the flight is too long to judge, nothing more is kept. */
  full(): boolean;
  /** The flight ended: its frames, each with the thread's work since the one
   *  before (the first: since the flight began). Empty when `full()`. */
  end(now: number): FrameSample[];
}

/** A flight beginning at `begin` (the camera command's moment). */
export function flightFrames(begin: number): FlightFrames {
  const pings: number[] = [begin];
  const frames: number[] = [];
  const full = () => frames.length >= MAX_FLIGHT_FRAMES || pings.length >= MAX_FLIGHT_PINGS;
  return {
    ping(now) {
      if (!full() && now >= pings[pings.length - 1]) pings.push(now);
    },
    frame(now) {
      const last = frames.length ? frames[frames.length - 1] : begin;
      if (!full() && now > last) frames.push(now);
    },
    full,
    end(now) {
      if (full()) return [];
      // The wait in progress is closed at the flight's end.
      const closed = now > pings[pings.length - 1] ? [...pings, now] : pings;
      const out: FrameSample[] = [];
      let from = begin;
      for (const at of frames) {
        const ms = at - from;
        out.push({ ms, workMs: Math.min(ms, threadWork(closed, from, at)) });
        from = at;
      }
      return out;
    },
  };
}

/** Whether a flight's frames are enough to judge: `minFrames` of them over
 *  `minMs` at least (the tier's own limits). */
export function flightTells(
  samples: readonly FrameSample[],
  minFrames: number,
  minMs: number,
): boolean {
  let total = 0;
  for (const s of samples) total += typeof s === "number" ? s : s.ms;
  return samples.length >= minFrames && total >= minMs;
}
