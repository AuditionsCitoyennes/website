// When the rise of a unit's plateau can start, as far as the plateau knows
// while its run is under way: what a tapped unit's pending mark times the
// leaving of its violet against (gl/PendingMarkPass.ts `riseEta`), so that
// the fill is nearly gone when the rise starts and never gone long before.
// An estimate, never a promise: the mark holds a floor of its fill until the
// plateau says the rise is cleared. Pure: no clock of its own, no import —
// run with `node --import tsx --test` (root "test:scripts").
//
// The rise starts once the run's data is in (the caller asks only then),
// the plateau that stood has sunk (`sinkEndAt`), a hold before the commit
// has passed (`holdEndAt`) and, where the rise waits for the camera
// ("after"), the flight in the air has landed
// (`flightEndAt`: its known end; 0: not known).

export interface RiseEtaInputs {
  now: number;
  /** A run for the unit is under way, or its plateau is committed and not
   *  up yet. False: nothing will rise for it that is known of. */
  running: boolean;
  /** When the sink of the plateau that stood ends (0: none under way). */
  sinkEndAt: number;
  /** When a hold before the commit ends (0: none). */
  holdEndAt: number;
  /** Whether the rise starts during the flight or after its landing. */
  order: "flight" | "after";
  /** A camera flight is in the air, and when it ends (0: not known). */
  flying: boolean;
  flightEndAt: number;
}

/** When the rise can start (`at`, a clock time, never before `now`), and
 *  whether that is a landing (told a frame and a task after the flight's
 *  end: lib/landing.ts). Null: not known. */
export function riseEta(i: RiseEtaInputs): { at: number; landing: boolean } | null {
  if (!i.running) return null;
  const base = Math.max(i.now, i.sinkEndAt || 0, i.holdEndAt || 0);
  if (i.order !== "after" || !i.flying) return { at: base, landing: false };
  if (!(i.flightEndAt > 0)) return null;
  return i.flightEndAt > base ? { at: i.flightEndAt, landing: true } : { at: base, landing: false };
}
