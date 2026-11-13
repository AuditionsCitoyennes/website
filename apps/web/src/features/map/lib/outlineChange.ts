// What a new outline asks of the plateau (ac:late-files "quiet",
// plateau/lateFilesSwitch.ts): a run of its pipeline, a reshape of its lines
// in place, or nothing.
//
// The outline is a fresh object at every recompute, on purpose (geo-nav's
// useMapFeed): the map must look at each one, because the same content has to
// raise the plateau again after a teardown. So the verdict never compares an
// outline with the outline before it — it compares it with what STANDS:
//
// - "run": the pipeline (usePlateau.ensurePlateau). Whenever nothing stands
//   for this outline's unit — none raised yet, a plateau cleared, failed or
//   torn down, a sink cut short — or the unit, its shape or its height
//   changed, or another unit's run is under way.
// - "owed": a run for this very shape is under way. It is left alone (a
//   restart would pay its relief source and its hold again); once it has
//   ended the outline is read again.
// - "redress": the plateau stands on this very shape and only the lines
//   around it changed (its children's, its neighbours'): one mesh, applied
//   in place (usePlateau.redress). No sink, no rise, no relief.
// - "nothing": it stands, dressed with exactly these lines.
//
// "This very shape" is the geometry OBJECT (the outline files hand out one
// object per outline and tier, never mutated), the unit's id and its height
// class. No import: loadable under node (outlineChange.test.ts).

/** What the verdict reads of a feature (the map's OutlineFC features). */
export interface OutlineFeatureLike {
  geometry?: unknown;
  properties?: { kind?: unknown; id?: unknown; level?: unknown; heightClass?: unknown } | null;
}

/** A raised shape: a unit, the geometry object it rises on, its height class. */
export interface RaisedShape {
  scopeId: string;
  geometry: unknown;
  heightClass: unknown;
}

export interface PlateauState {
  /** The plateau standing whole (up, or rising to it, on its own terrain); null: none. */
  standing: RaisedShape | null;
  /** The shape the run under way raises; null: no run past its first checks. */
  running: RaisedShape | null;
  /** The lines the standing plateau was last dressed with (focus, then context). */
  dressed: readonly OutlineFeatureLike[];
}

export type OutlineVerdict = "run" | "owed" | "redress" | "nothing";

const kindOf = (f: OutlineFeatureLike) => f.properties?.kind;

/** The raised shape an outline asks for: its one "scope" feature (null: none, or several). */
export function raisedShapeOf(features: readonly OutlineFeatureLike[]): RaisedShape | null {
  const raised = features.filter((f) => kindOf(f) === "scope");
  if (raised.length !== 1) return null;
  const [f] = raised;
  return {
    scopeId: String(f.properties?.id ?? ""),
    geometry: f.geometry,
    heightClass: f.properties?.heightClass,
  };
}

/** The lines an outline dresses its plateau with: focus, then context. */
export function linesOf<F extends OutlineFeatureLike>(features: readonly F[]): F[] {
  return [
    ...features.filter((f) => kindOf(f) === "focus"),
    ...features.filter((f) => kindOf(f) === "context"),
  ];
}

export const sameShape = (a: RaisedShape, b: RaisedShape): boolean =>
  a.scopeId === b.scopeId && a.geometry === b.geometry && a.heightClass === b.heightClass;

/** The same lines, in order: each one's kind, unit, level and geometry object. */
export function sameLines(
  a: readonly OutlineFeatureLike[],
  b: readonly OutlineFeatureLike[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((f, i) => {
    const g = b[i];
    return (
      f.geometry === g.geometry &&
      kindOf(f) === kindOf(g) &&
      f.properties?.id === g.properties?.id &&
      f.properties?.level === g.properties?.level
    );
  });
}

/** What `features` (an outline's) asks of the plateau in `state`. */
export function outlineVerdict(
  features: readonly OutlineFeatureLike[],
  state: PlateauState,
): OutlineVerdict {
  const next = raisedShapeOf(features);
  if (!next) return "run"; // nothing to raise, or a hold: the pipeline's call
  if (state.running) return sameShape(next, state.running) ? "owed" : "run";
  if (!state.standing || !sameShape(next, state.standing)) return "run";
  return sameLines(linesOf(features), state.dressed) ? "nothing" : "redress";
}
