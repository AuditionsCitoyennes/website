// The waits of a committed plateau's rise, in order (usePlateau's
// riseCleared): the camera's landing where the rise waits for it, then the
// gate — the pending mark's violet leaving the unit (gl/PendingMarkPass
// `gateMs(true)`: reading it also tells the mark that everything else the
// rise waits for is satisfied, so a fade that waited for that begins now). The
// gate is read again after every wait, and waited for again while it is not
// 0 (the fade began late, a frame was slow) — a bounded number of rounds: a
// hidden tab draws no frame, and the rise must still come. Pure: the gate
// and the waits are given — run with `node --import tsx --test` (root
// "test:scripts").

import type { RiseStart } from "./riseHold";

/** The gate is read at most this many times after the first wait. */
export const RISE_GATE_ROUNDS = 4;

export interface RiseSequenceInputs {
  /** The rise waits for the camera's landing first. */
  waits: boolean;
  /** How long the rise is still held, ms — read with "cleared": the reader
   *  latches that the rise only waits for it. */
  gate(): number;
  /** One wait of `ms` — with `landing`, also for the camera's landing. It
   *  ends "start", or "dropped"/"taken" (lib/riseHold.ts). */
  wait(ms: number, landing: boolean): Promise<RiseStart>;
}

/**
 * Runs the waits; answers how they ended and whether anything was waited
 * for (`waited` false: the rise starts in the caller's own task).
 */
export async function riseSequence({
  waits,
  gate,
  wait,
}: RiseSequenceInputs): Promise<{ how: RiseStart; waited: boolean }> {
  let waited = false;
  if (waits) {
    // The landing first: the gate is told "cleared" only once it has come.
    waited = true;
    const how = await wait(0, true);
    if (how !== "start") return { how, waited };
  }
  for (let round = 0; round < RISE_GATE_ROUNDS; round++) {
    const ms = gate();
    if (!(ms > 0)) break;
    waited = true;
    const how = await wait(ms, false);
    if (how !== "start") return { how, waited };
  }
  return { how: "start", waited };
}
