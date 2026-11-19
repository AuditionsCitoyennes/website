// How much of the outline file(s) a tapped unit's plateau waits for has
// arrived, as one share from 0 to 0.9: what the pending mark's loading line
// shows while the file comes (map/plateau/tapProgress.ts turns it into the
// line's value; the file stored is told apart, as 1). Fed by the outline
// loader's steps for the files the page calls urgent (useMapFeed). No clock,
// no import: loadable under node (urgentProgress.test.ts).
//
// One file's share: 0 before its response, URGENT_ANSWERED once it is
// answered, then up to URGENT_BODY more as its body arrives, 1 once the body
// is whole. The body's share is exact when the response gives its size;
// when it does not (a compressed transfer: the size is unknown until the
// end) it follows 1 − e^(−bytes / URGENT_BODY_SCALE): it moves with every
// piece that arrives, a file of the usual size (45 to 290 KB decoded) being
// a third to nine tenths of the way at its last piece, and can never reach
// the end before the body is whole.
//
// The whole: the mean share over the files expected (or seen, if more came),
// URGENT_CAP at most — the last tenth is the file stored.

/** A file's share once its response is answered, and its body's. */
export const URGENT_ANSWERED = 0.3;
export const URGENT_BODY = 0.6;
/** The decoded bytes at which a body of unknown size counts for 63%. */
export const URGENT_BODY_SCALE = 120_000;
/** The whole's share while a file is not stored yet, at most. */
export const URGENT_CAP = 0.9;

export type UrgentPhase = "answered" | "bytes" | "landed";

export function createUrgentProgress() {
  let scope = "";
  let expected = 1;
  const shares = new Map<string, number>();

  return {
    /** The plateau of unit `scopeId` waits for `files` outline files from now. */
    begin(scopeId: string, files: number) {
      scope = scopeId;
      expected = Math.max(1, Math.round(files) || 1);
      shares.clear();
    },
    /** A step of file `key`. The whole's share, or null: nothing is waited
     *  for, or the step changes nothing. */
    note(key: string, phase: UrgentPhase, received: number, total: number | null): number | null {
      if (!scope) return null;
      const before = shares.get(key) ?? 0;
      let share = before;
      if (phase === "landed") share = 1;
      else if (phase === "answered") share = Math.max(before, URGENT_ANSWERED);
      else {
        const bytes = Number.isFinite(received) && received > 0 ? received : 0;
        const b =
          total !== null && total > 0
            ? Math.min(1, bytes / total)
            : 1 - Math.exp(-bytes / URGENT_BODY_SCALE);
        share = Math.max(before, URGENT_ANSWERED + URGENT_BODY * b);
      }
      if (share === before && shares.has(key)) return null;
      shares.set(key, share);
      let sum = 0;
      for (const v of shares.values()) sum += v;
      return Math.min(URGENT_CAP, sum / Math.max(shares.size, expected));
    },
    /** Nothing is waited for any more. */
    end() {
      scope = "";
      shares.clear();
    },
    /** The unit waited for, "" when none. */
    scope: () => scope,
  };
}

export type UrgentProgress = ReturnType<typeof createUrgentProgress>;
