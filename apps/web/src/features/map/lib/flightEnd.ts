// When the camera flight in the air will end: the duration it was issued
// with, counted from the call (useMapCamera.flyCamera). What a tapped unit's
// pending mark needs to time its fill's fade against a rise that waits for
// the landing (plateau/riseEta.ts). An estimate: mapbox starts its own clock
// a moment later, and a gesture or a newer flight cuts a flight short — the
// reader re-reads it and never relies on it alone. Pure: the clock is given.
// Run with `node --import tsx --test` (root "test:scripts").

export function createFlightEnd(now: () => number = () => performance.now()) {
  let flight = 0;
  let endAt = 0;
  return {
    /** Flight `id` is in the air for `ms` from now (0 or less: not known).
     *  It replaces the one before. */
    begin(id: number, ms: number | undefined) {
      flight = id;
      endAt = ms !== undefined && ms > 0 ? now() + ms : 0;
    },
    /** Flight `id` has ended (its own `moveend`): nothing known any more —
     *  unless a newer flight has replaced it. */
    ended(id: number) {
      if (id !== flight) return;
      flight = 0;
      endAt = 0;
    },
    /** No flight (an instant move, a failed one). */
    none() {
      flight = 0;
      endAt = 0;
    },
    /** When the flight in the air ends, a clock time; 0: none, or not known. */
    at: () => endAt,
  };
}

export type FlightEnd = ReturnType<typeof createFlightEnd>;
