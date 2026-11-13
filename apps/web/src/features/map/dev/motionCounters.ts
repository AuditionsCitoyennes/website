// Two counters of the map's testing tools, apart from the page
// (motionProbes.ts installs them):
//
// - `motion-mutations`: the map mutations the app issued while the map was in
//   motion — the camera moving, a plateau rising or sinking, a pointer down —
//   by mutator name (setTerrain, addLayer, removeLayer, addSource,
//   removeSource, setPaintProperty, setLayoutProperty, setFilter, a source's
//   setData), by the label of the scope the caller opened around them
//   ("(none)" without one) and by what they touched (a layer's or a source's
//   id). A scope can declare its mutations planned: the unplanned ones are
//   counted apart, so they stand out. Every mutation is counted in `total`,
//   moving map or not.
// - `plateau-runs`: how many times the plateau pipeline ran for one
//   selection — a run for the unit of the run before it is the same
//   selection's.
//
// No import: loadable under node (motionCounters.test.ts).

/** The map's own mutators that are wrapped (a source's setData apart). */
export const MAP_MUTATORS = [
  "setTerrain",
  "addLayer",
  "removeLayer",
  "addSource",
  "removeSource",
  "setPaintProperty",
  "setLayoutProperty",
  "setFilter",
] as const;

/** What a mutation touched, from its arguments: a layer's or a source's id
 *  (setTerrain: its source, "null" for the terrain cleared). */
export function mutationTarget(name: string, args: readonly unknown[]): string {
  const first = args[0] as { id?: unknown; source?: unknown } | string | null | undefined;
  if (name === "setTerrain") {
    return first && typeof first === "object" ? String(first.source ?? "?") : "null";
  }
  if (name === "addLayer") return first && typeof first === "object" ? String(first.id) : "?";
  return typeof first === "string" ? first : "?";
}

/** What the map is busy with (lib/stillMap.ts: `busy()`). */
export interface MotionState {
  camera: boolean;
  plateau: boolean;
  pointer: boolean;
}

export interface MutationRow {
  /** Issued in motion. */
  n: number;
  /** …of which not declared planned. */
  unplanned: number;
  /** …while the camera moved, a plateau rose or sank, a pointer was down
   *  (a mutation can count in several). */
  camera: number;
  plateau: number;
  pointer: number;
  /** By the caller's label, and by the label of the unplanned ones. */
  labels: Record<string, number>;
  unplannedLabels: Record<string, number>;
  /** By what they touched. */
  targets: Record<string, number>;
}

export const NO_LABEL = "(none)";

export function createMutationCounter(busy: () => MotionState) {
  let total = 0;
  let inMotion = 0;
  let unplanned = 0;
  let byName: Record<string, MutationRow> = {};
  const scopes: { label: string; planned: boolean }[] = [];
  const bump = (into: Record<string, number>, key: string) => {
    into[key] = (into[key] ?? 0) + 1;
  };

  /** A mutation issued now: `name` the mutator, `target` what it touches. */
  function note(name: string, target = "?") {
    total++;
    const b = busy();
    if (!b.camera && !b.plateau && !b.pointer) return;
    inMotion++;
    const row = (byName[name] ??= {
      n: 0,
      unplanned: 0,
      camera: 0,
      plateau: 0,
      pointer: 0,
      labels: {},
      unplannedLabels: {},
      targets: {},
    });
    row.n++;
    if (b.camera) row.camera++;
    if (b.plateau) row.plateau++;
    if (b.pointer) row.pointer++;
    const label = scopes.at(-1)?.label ?? NO_LABEL;
    bump(row.labels, label);
    bump(row.targets, target);
    if (!scopes.some((s) => s.planned)) {
      unplanned++;
      row.unplanned++;
      bump(row.unplannedLabels, label);
    }
  }

  /** The mutations issued until the function returned is called carry
   *  `label`; with `planned`, they are declared planned (and those of the
   *  scopes opened inside it). Synchronous code only: close it before any
   *  await — a scope left open shows as `openScopes` in the dump. */
  function scope(label: string, opts: { planned?: boolean } = {}): () => void {
    const entry = { label, planned: !!opts.planned };
    scopes.push(entry);
    return () => {
      const at = scopes.lastIndexOf(entry);
      if (at !== -1) scopes.splice(at, 1);
    };
  }

  return {
    note,
    scope,
    read: () => ({
      total,
      inMotion,
      unplanned,
      byName: JSON.parse(JSON.stringify(byName)) as Record<string, MutationRow>,
      openScopes: scopes.length,
    }),
    reset() {
      total = 0;
      inMotion = 0;
      unplanned = 0;
      byName = {};
    },
  };
}

/** A selection's runs of the plateau pipeline. */
export interface PlateauSelection {
  /** The unit's id; "" for the plateau cleared (Monde, the micropin zone). */
  scope: string;
  runs: number;
  /** The first run's and the last run's time (performance.now()). */
  t0: number;
  last: number;
}

/** The selections kept (the oldest dropped first). */
export const KEEP_SELECTIONS = 100;

export function createPlateauRuns(now: () => number) {
  let selections: PlateauSelection[] = [];

  /** The pipeline runs for `scope`: the same selection as the run before it
   *  when it is for the same unit. */
  function note(scope: string) {
    const t = Math.round(now());
    const cur = selections.at(-1);
    if (cur && cur.scope === scope) {
      cur.runs++;
      cur.last = t;
      return;
    }
    selections.push({ scope, runs: 1, t0: t, last: t });
    if (selections.length > KEEP_SELECTIONS) selections.shift();
  }

  return {
    note,
    read: () => ({
      selections: selections.length,
      runs: selections.reduce((a, s) => a + s.runs, 0),
      /** The most runs one selection took. */
      max: selections.reduce((a, s) => Math.max(a, s.runs), 0),
      last: selections.length ? { ...selections[selections.length - 1] } : null,
      list: selections.map((s) => ({ ...s })),
    }),
    reset() {
      selections = [];
    },
  };
}
