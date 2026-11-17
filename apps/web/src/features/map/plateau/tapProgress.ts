// How far the data a tapped unit's plateau waits for has come, as one number
// from 0 to 1: what the pending mark's loading line shows along the unit's
// boundary (gl/PendingMarkPass.ts). Fed by real events only — the page's
// outline files (`outline`: headers, bytes, stored — the unit's own and,
// for a unit whose plateau waits for its children's boundaries, its bundle:
// every file the rise waits for), and the plateau
// pipeline's run for the unit (`run`: it has started, and what it needs;
// `key`: the relief version key is in; `mesh`: the wall and lid mesh is
// built; `settled`: the run's verdict). No clock, no import: loadable under
// node (tapProgress.test.ts).
//
// The requirements and their weights: the unit's own outline when it was not
// in memory at the tap (6), the pipeline's run for the unit started (1: it
// has an outline to raise), the relief key on raised ground (1), the mesh
// when the worker builds it (3). The value is the share of the weights that
// are in, the outline counting for the share of its file that has arrived
// (0.9 at most until it is stored), and:
// - it never goes down;
// - it is 1 only once a run is declared and every requirement it counts is
//   in (a run that needs nothing: 1 at once), or at the run's verdict;
//   before that it stays at 0.95 at most;
// - before any run, a tap whose outline is in memory shows 0.
// So a tap never has a one-step line: the run's start is a step of its own.
//
// A run that starts while the outline's file is still on its way rises on a
// coarser outline of the unit, in memory since before the tap (the page
// stopped waiting for the file: geo-nav's selfHold, ac:outline-wait). The
// file the line measured has not come, and no timer may move the line: from
// then on the tap is `waived` — the value keeps what it showed, never 1,
// `note` answers null, and the page lets the mark fade where it stands
// before that plateau rises (GeoDrillMap.pendingStep). Only a later run that
// finds the file stored (« Réessayer ») counts again.
//
// 1 means "the data of the run that was current is all in". A later run for
// the same unit (a finer outline landing during the sink, the relief lost
// and asked again) does not reopen the line: the value stays 1 and `note`
// answers null.

/** A real step toward a tapped unit's plateau. */
export type TapStep =
  /** The share of the outline files the rise waits for that has arrived, 0
   *  to 1 (1: they are stored, or no longer waited for). The first one says
   *  something of them was not in memory. */
  | { t: "outline"; frac: number }
  /** A pipeline run for the unit: whether it waits for a relief key and for
   *  a mesh from the worker. */
  | { t: "run"; key: boolean; mesh: boolean }
  | { t: "key" }
  | { t: "mesh" }
  /** The run's verdict (rise, same, quiet). */
  | { t: "settled" };

/** The steps the plateau pipeline reports (usePlateau's `onProgress`). */
export type PlateauStep = Exclude<TapStep, { t: "outline" } | { t: "settled" }>;

export const TAP_WEIGHT_OUTLINE = 6;
export const TAP_WEIGHT_RUN = 1;
export const TAP_WEIGHT_KEY = 1;
export const TAP_WEIGHT_MESH = 3;
/** The outline's share while its file is not stored yet, at most. */
export const TAP_OUTLINE_CAP = 0.9;
/** The value while a counted requirement is still out, at most. */
export const TAP_OPEN_CAP = 0.95;

interface State {
  id: string;
  /** What a run for the unit will most likely need (known at the tap). */
  expect: { key: boolean; mesh: boolean };
  /** The outline was not in memory at the tap; how much of it has come. */
  cold: boolean;
  frac: number;
  stored: boolean;
  /** The current run's needs. */
  run: { key: boolean; mesh: boolean } | null;
  /** The current run started without the outline's file: the value is
   *  kept as it was. */
  waived: boolean;
  keyIn: boolean;
  meshIn: boolean;
  settled: boolean;
  value: number;
}

export function createTapProgress() {
  let s: State | null = null;

  function compute(c: State): number {
    if (c.settled) return 1;
    const outline = c.stored ? 1 : Math.min(c.frac, TAP_OUTLINE_CAP);
    const cold = c.cold ? TAP_WEIGHT_OUTLINE : 0;
    if (!c.run) {
      if (!c.cold) return 0;
      const total =
        cold +
        TAP_WEIGHT_RUN +
        (c.expect.key ? TAP_WEIGHT_KEY : 0) +
        (c.expect.mesh ? TAP_WEIGHT_MESH : 0);
      return Math.min(TAP_OPEN_CAP, (cold * outline) / total);
    }
    const open = (c.run.key && !c.keyIn) || (c.run.mesh && !c.meshIn);
    if (!open) return 1; // a run that needs nothing included
    const rest =
      TAP_WEIGHT_RUN + (c.run.key ? TAP_WEIGHT_KEY : 0) + (c.run.mesh ? TAP_WEIGHT_MESH : 0);
    const restIn =
      TAP_WEIGHT_RUN +
      (c.run.key && c.keyIn ? TAP_WEIGHT_KEY : 0) +
      (c.run.mesh && c.meshIn ? TAP_WEIGHT_MESH : 0);
    // A run is declared with the outline in memory: its weight is in.
    return Math.min(TAP_OPEN_CAP, (cold + restIn) / (cold + rest));
  }

  return {
    /**
     * A tap on unit `id`. `again` with the same unit (« Réessayer », the
     * same unit tapped while it was pending): what has arrived is kept.
     * Otherwise the count starts over, a unit tapped before included.
     */
    begin(id: string, expect: { key: boolean; mesh: boolean }, again: boolean) {
      if (again && s?.id === id) return;
      s = {
        id,
        expect: { ...expect },
        cold: false,
        frac: 0,
        stored: false,
        run: null,
        waived: false,
        keyIn: false,
        meshIn: false,
        settled: false,
        value: 0,
      };
    },
    /**
     * A step for unit `id`. Answers the new value and whether the data is
     * all in (`done`, said once), or null: another unit's step, or one that
     * changes nothing.
     */
    note(id: string, step: TapStep): { value: number; done: boolean } | null {
      const c = s;
      if (!c || c.id !== id) return null;
      if (c.value >= 1) return null; // the line is full: nothing reopens it
      switch (step.t) {
        case "outline": {
          const f = Number.isFinite(step.frac) ? Math.min(1, Math.max(0, step.frac)) : 0;
          c.cold = true;
          if (f > c.frac) c.frac = f;
          if (f >= 1) c.stored = true;
          break;
        }
        case "run":
          // Without the outline's file: the line stops where it is — until
          // a later run finds the file stored (a retry's).
          c.waived = c.cold && !c.stored;
          // A new run: its own key and mesh are still to come.
          c.run = { key: step.key, mesh: step.mesh };
          c.keyIn = false;
          c.meshIn = false;
          break;
        case "key":
          c.keyIn = true;
          break;
        case "mesh":
          c.meshIn = true;
          break;
        case "settled":
          c.settled = true;
          break;
      }
      if (c.waived) return null; // the file has not come: nothing moves the line
      const next = Math.max(c.value, compute(c));
      if (next === c.value) return null;
      c.value = next;
      return { value: next, done: next >= 1 };
    },
    /** The tap's state is over (the pending state ended). */
    end() {
      s = null;
    },
    /** The unit followed, "" when none, and its value (0 when none). */
    id: () => s?.id ?? "",
    value: () => s?.value ?? 0,
    /** A run for the unit started without its outline's file. */
    waived: () => !!s?.waived,
    /** What the testing tools read. */
    state: () => (s ? { ...s, expect: { ...s.expect }, run: s.run ? { ...s.run } : null } : null),
  };
}

export type TapProgress = ReturnType<typeof createTapProgress>;
