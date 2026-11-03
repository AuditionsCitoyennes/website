// Which outline-file object a country is drawn and raised with, and which of
// its files are asked for (ac:contours=fichiers; the country files of the
// build, docs/map-outlines.md). Pure: over the store's rows and objects, no
// Vue, nothing at import but declarations.
//
// - A row with k:1 (France) is its k/ self in every role: g/FR is never asked.
// - Any other country is drawn with its g/ (the world tier, w3000) and raised
//   with its u/ (its own tier), each standing in for the other until it lands.
// - A row at c3000 is served by its g/ alone: its u/ is the same geometry
//   under another tier tag (the same 3000 m run).
// - A micro-state (its box's diagonal under MICRO_DIAG_KM, e.g. Monaco) takes
//   its u/ (≤ ~1 KB) in every role: a 3000 m sliver can miss its own lieux.
// - Known absent, never asked for (box fit, pins, no plateau): no row; a row
//   spanning half the world or more (Antarctica: no fit or mesh holds it); a
//   row with `wrap` (its outline runs past ±180°, which the map's box tests do
//   not handle yet).
import type { Bounds } from "./types";
import type { OutlineKind } from "./outlines";

/** At most this many countries in the first globe batch, by the tree's order. */
export const GLOBE_CAP = 40;
/** At most this many neighbours' selves in a country scope's batch. */
export const SIBLING_SELF_CAP = 8;
/** Below this box diagonal a country is a micro-state. */
export const MICRO_DIAG_KM = 12;
/** The country tier cut by the globe's own run: its u/ is its g/. */
const GLOBE_RUN_TIER = "c3000";

/** A row as these rules read it (the store's OutlineRow; a missing field is
 *  a 0 flag, a box of no size). */
export interface RoleRow {
  st: string;
  k: 0 | 1;
  u: 0 | 1;
  g?: 0 | 1;
  bounds?: Bounds;
  wrap?: boolean;
}

/** A box spanning half the world's longitudes or more. */
export const spansWorld = (b: Bounds): boolean => b.maxLng - b.minLng >= 180;

function diagKm(b: Bounds): number {
  const cos = Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180);
  return Math.hypot((b.maxLng - b.minLng) * 111.32 * cos, (b.maxLat - b.minLat) * 110.574);
}

export const isMicro = (row: RoleRow): boolean =>
  !!row.bounds && diagKm(row.bounds) < MICRO_DIAG_KM;

/** No outline for it this session, and none is asked for. */
export const rowKnownAbsent = (row: RoleRow | undefined): boolean =>
  !row || !!row.wrap || (!!row.bounds && spansWorld(row.bounds));

/** The file a unit's self (its raised outline) comes from: its bundle (k:1),
 *  its u/ (but at c3000), else its g/; null when none will come. */
export function selfFileOf(row: RoleRow | undefined): OutlineKind | null {
  if (!row || rowKnownAbsent(row)) return null;
  if (row.k) return "k";
  if (row.u && (row.st !== GLOBE_RUN_TIER || !row.g)) return "u";
  return row.g ? "g" : null;
}

/** What a hover asks for ahead of the click: the one file its self comes
 *  from, when that is a k/ or a u/ (a g/ is the globe batch's). */
export function prefetchKind(row: RoleRow | undefined): "k" | "u" | null {
  const kind = selfFileOf(row);
  return kind === "k" || kind === "u" ? kind : null;
}

export interface RoleObjects<G> {
  selfOf(id: string): G | undefined;
  globeOf(id: string): G | undefined;
}

/** A country's object: `raised`, the one its plateau rises on (its self
 *  first); else the one its line and hit rings are drawn with (its g/ first). */
export function countryOutline<G>(
  v: RoleObjects<G>,
  id: string,
  row: RoleRow | undefined,
  raised: boolean,
): G | undefined {
  const kind = selfFileOf(row);
  if (kind === "k" || (kind === "u" && isMicro(row!))) return v.selfOf(id);
  if (kind === "g") return v.globeOf(id);
  if (kind !== "u") return undefined;
  return raised ? (v.selfOf(id) ?? v.globeOf(id)) : (v.globeOf(id) ?? v.selfOf(id));
}

/** The countries whose world outline the globe batch asks for, from
 *  `countries` (the tree's, in its order): the first GLOBE_CAP with one, then
 *  those beyond whose box meets `view`. `g`: their g/; `u`: the micro-states'
 *  u/ instead. France (k:1) and known-absent rows are left out. */
export function globeBatch(
  countries: readonly { id: string; bounds: Bounds }[],
  rowOf: (id: string) => RoleRow | undefined,
  view?: Bounds | null,
  cap = GLOBE_CAP,
): { g: string[]; u: string[] } {
  const g: string[] = [];
  const u: string[] = [];
  const near = view && padded(view, VIEW_PAD);
  let n = 0;
  for (const c of countries) {
    const row = rowOf(c.id);
    const kind = selfFileOf(row);
    if (!kind || kind === "k") continue;
    const micro = kind === "u" && isMicro(row!);
    if (!micro && !row!.g) continue;
    if (n++ >= cap && !(near && boxesMeet(c.bounds, near))) continue;
    (micro ? u : g).push(c.id);
  }
  return { g, u };
}

/** A country scope's neighbours whose u/ is asked for (their raised lines
 *  beside its edge): the siblings whose box meets the scope's, in the
 *  tree's order, the first `cap`. */
export function siblingSelves(
  scope: { id: string; bounds: Bounds },
  siblings: readonly { id: string; bounds: Bounds }[],
  rowOf: (id: string) => RoleRow | undefined,
  cap = SIBLING_SELF_CAP,
): string[] {
  return siblings
    .filter(
      (s) =>
        s.id !== scope.id && selfFileOf(rowOf(s.id)) === "u" && boxesMeet(s.bounds, scope.bounds),
    )
    .slice(0, cap)
    .map((s) => s.id);
}

const boxesMeet = (a: Bounds, b: Bounds) =>
  a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLng <= b.maxLng && a.maxLng >= b.minLng;

/** The view beyond the cap is met padded by this share of its span each way. */
const VIEW_PAD = 0.15;
function padded(b: Bounds, share: number): Bounds {
  const lat = (b.maxLat - b.minLat) * share;
  const lng = (b.maxLng - b.minLng) * share;
  return {
    minLat: b.minLat - lat,
    maxLat: b.maxLat + lat,
    minLng: b.minLng - lng,
    maxLng: b.maxLng + lng,
  };
}
