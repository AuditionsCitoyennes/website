// Which grey sheet the flat view shows and which is on its way
// (gl/ScopeTintLayer.ts, ac:tint-cut): a selection's sheet is cut here, in
// the call, or asked of a cutter that answers later (the mesh worker,
// gl/meshClient.ts) and laid when it does. At most one cut is in flight or
// kept, for one selection; a newer selection drops it, and its answer with
// it. Selections are compared by their geometry OBJECTS: boundary data is
// identity-stable. Pure: no DOM, no GL, no alias at run time
// (tintCuts.test.ts).

import type { MaskGeom, TintSheet } from "./tintSheet";

export const sameGeoms = (a: readonly MaskGeom[], b: readonly MaskGeom[]) =>
  a.length === b.length && a.every((g, i) => g === b[i]);

/** Who cuts a sheet off the page; null: no sheet (lost, or superseded). */
export type TintCutFn = (
  geoms: readonly MaskGeom[],
) => Promise<(TintSheet & { ms: number }) | null>;

export interface TintCutsDeps {
  /** The cutter, if one can answer now (the switch, a live worker); else null. */
  cutter(): TintCutFn | null;
  /** The sheet around `geoms`, cut here. */
  cutHere(geoms: readonly MaskGeom[]): TintSheet;
  /** A sheet is laid: what the flat view draws from now on. */
  lay(sheet: TintSheet, via: "page" | "worker"): void;
  /** A sheet `select` answered false for (on its way) is laid now. */
  onLate?(): void;
  /** A cutter's answer came with a sheet (its own time, its vertices). */
  onCut?(ms: number, vertices: number): void;
}

export function createTintCuts(deps: TintCutsDeps) {
  /** The selection whose sheet is laid. */
  let laid: readonly MaskGeom[] = [];
  /** The one cut asked of the cutter: `sheet` once it answered, `wanted`
   *  once `select` asked for these geometries (laid as it lands). */
  let cut: { geoms: readonly MaskGeom[]; sheet: TintSheet | null; wanted: boolean } | null = null;

  function put(geoms: readonly MaskGeom[], sheet: TintSheet, via: "page" | "worker") {
    laid = geoms;
    deps.lay(sheet, via);
  }

  /** `geoms` asked of `cutter`: the answer is laid if `select` wanted it
   *  meanwhile, kept for it otherwise; no answer, and wanted: cut here. */
  function ask(cutter: TintCutFn, geoms: readonly MaskGeom[], wanted: boolean) {
    const mine = { geoms, sheet: null as TintSheet | null, wanted };
    cut = mine;
    void cutter(geoms).then((res) => {
      // Another selection since, or dropped.
      if (cut !== mine) return;
      if (res) deps.onCut?.(res.ms, res.positions.length / 2);
      const sheet = res ? { positions: res.positions, origin: res.origin } : null;
      if (!mine.wanted) {
        if (sheet) mine.sheet = sheet;
        else cut = null;
        return;
      }
      cut = null;
      if (sheet) put(geoms, sheet, "worker");
      else put(geoms, deps.cutHere(geoms), "page");
      deps.onLate?.();
    });
  }

  return {
    /** The sheet around `geoms` asked of the cutter ahead of the `select`
     *  that will lay it. Nothing without a cutter, for no geometry, or for
     *  the selection laid or on its way. */
    prepare(geoms: readonly MaskGeom[]) {
      const cutter = deps.cutter();
      if (!cutter || !geoms.length || sameGeoms(geoms, laid)) return;
      if (cut && sameGeoms(cut.geoms, geoms)) return;
      ask(cutter, geoms, false);
    },
    /** The sheet around `geoms` is the one to show (empty: no grey). True:
     *  laid in this call (cut here, or kept from the cutter). False: already
     *  laid, or on its way from the cutter — `onLate` is called as it lands. */
    select(geoms: readonly MaskGeom[]): boolean {
      if (sameGeoms(geoms, laid)) {
        // What is laid is wanted again: a cut on its way is another selection's.
        if (cut) cut.wanted = false;
        return false;
      }
      const cutter = geoms.length ? deps.cutter() : null;
      if (cutter && cut && sameGeoms(cut.geoms, geoms)) {
        if (!cut.sheet) {
          cut.wanted = true;
          return false;
        }
        const { sheet } = cut;
        cut = null;
        put(geoms, sheet, "worker");
        return true;
      }
      if (cutter) {
        ask(cutter, geoms, true);
        return false;
      }
      cut = null;
      put(geoms, deps.cutHere(geoms), "page");
      return true;
    },
    /** The cut in flight or kept is forgotten, its answer with it (the map
     *  is going away: nothing is cut in its place). */
    drop() {
      cut = null;
    },
    /** The selection whose sheet is laid. */
    laid: () => laid,
    /** The cut asked of the cutter: "wanted" (laid as it lands), "ahead"
     *  (prepared, not asked for yet), "kept" (answered, waiting for its
     *  select); null: none. */
    pending: () => (cut ? (cut.sheet ? "kept" : cut.wanted ? "wanted" : "ahead") : null),
  };
}
