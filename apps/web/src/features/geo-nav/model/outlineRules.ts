// The explorer's outlines read from the static outline files
// (ac:contours=fichiers, data/useOutlineFiles.ts). Pure: no Vue, no DOM — over
// the OutlineView useGeoHierarchy hands in.
//
// 0. Under the server's tree only (GeoNav decides): its unit ids ARE the
//    files' (FR, fr:reg:<code>, fr:dep:<code>, fr:com:<insee>); the corpus'
//    are paths, which no file names.
// 1. A unit is drawn with, for a country, its self (k/FR); below it, its entry
//    in its PARENT's bundle — none until k/<parent> is in, even when an object
//    for it came with another file. Raised: its self once stored, else that.
//    Below the région the entry IS the self (one object, `id@e50`).
// 2. A plateau waits for its self while its row declares one (k or u), it is
//    not stored, its file did not fail and the wait was not given up
//    (OUTLINE_WAIT_MS). Pending: waiting, or no geometry while some may still
//    come — never once the scope's chain is settled: the hold is bounded.
// 3. The lid's lines (focus) are the entries of the scope's own bundle, cut
//    by the same run as its self: a line the lid lifts lies on its edge.
// 4. Refinement: the neighbours drawn at a coarser tier than their self, and
//    the départements of other régions on screen, get their selves in ONE
//    batch after the scope's bundle, nearest first, capped (REFINE_CAPS).
// 5. The session falls back at boot (root.json, k/FR, the 6 s cap), or on a
//    release skew of any later file (useOutlineFiles): from then on every
//    answer is the API's (outlineRules). A later file failing is its unit's
//    alone (known absent; on the network, asked again by a later ensure).
// 6. The chain: a scope's bundles, root first (bundlesFor), loaded in turn.
import type { Bounds, GeoUnit } from "@/features/geo";

export type RuleUnit = Pick<
  GeoUnit,
  "id" | "parentId" | "levelKey" | "depth" | "center" | "bounds"
>;
export type BundleState = "none" | "loading" | "loaded" | "failed";

/** The outline files as the rules read them. */
export interface OutlineView {
  /** "fichiers": the files are read; anything else: the API's answers. */
  readonly mode: string;
  /** Its row (root.json's, or its entry's once its parent's bundle is in). */
  rowOf(id: string): { st: string; k: 0 | 1; u: 0 | 1 } | undefined;
  selfOf(id: string): object | undefined;
  /** The entries of its loaded bundle (undefined until k/<id> is in). */
  unitsOf(id: string): ReadonlyMap<string, object> | undefined;
  bundleState(id: string): BundleState;
  /** Its self's file (k/ or u/) will not come this session. */
  failed(id: string): boolean;
  /** Its plateau stopped waiting for its self. */
  gaveUp(id: string): boolean;
}

/** At most this many selves per refinement batch, by the scope's level.
 *  None for a région: its neighbours stay on their fr1000 entries (≤ ~1 km
 *  off at its fit). Their e50 selves (3 nearest: ~18k more vertices at ARA)
 *  cost the plateau's mesh a second build of ~300 ms at CPU x4, after the
 *  first (~220 ms, its own e50 lines; the API's: ~60 ms) — back once the mesh
 *  is built off the main thread (pr-mesh-worker). */
export const REFINE_CAPS = { region: 0, dep: 8 } as const;

export function geometryFor(v: OutlineView, u: RuleUnit): object | undefined {
  if (u.levelKey === "country") return v.selfOf(u.id);
  if (!u.parentId || u.levelKey === "world" || u.levelKey === "place") return undefined;
  return v.unitsOf(u.parentId)?.get(u.id);
}

export const raisedGeometryFor = (v: OutlineView, u: RuleUnit): object | undefined =>
  v.selfOf(u.id) ?? geometryFor(v, u);

const declaresSelf = (v: OutlineView, id: string) => {
  const row = v.rowOf(id);
  return !!row && (row.k === 1 || row.u === 1);
};

export const raisedOutlineDue = (v: OutlineView, u: RuleUnit): boolean =>
  declaresSelf(v, u.id) && !v.selfOf(u.id) && !v.failed(u.id) && !v.gaveUp(u.id);

/** Levels whose rows come with their parent's bundle (root.json stops at the
 *  départements): each such ancestor's bundle is on the chain. */
const DEEP: ReadonlySet<string> = new Set(["dep", "city", "arr"]);

/** The k/ files a scope needs, root first: its ancestors' from the
 *  département down, its parent's, its own — k:0 rows left out, rows not
 *  known yet kept. `chain`: the scope's ancestors, root first, then it. */
export function bundlesFor(v: OutlineView, chain: readonly RuleUnit[]): string[] {
  const ids: string[] = [];
  const add = (u: RuleUnit | undefined) => {
    if (!u || u.levelKey === "world" || u.levelKey === "place") return;
    if (v.rowOf(u.id)?.k !== 0 && !ids.includes(u.id)) ids.push(u.id);
  };
  for (const u of chain.slice(0, -2)) if (DEEP.has(u.levelKey)) add(u);
  add(chain[chain.length - 2]);
  add(chain[chain.length - 1]);
  return ids;
}

/** Every bundle of the chain is in, failed, or not declared. */
export const bundlesSettled = (v: OutlineView, chain: readonly RuleUnit[]): boolean =>
  bundlesFor(v, chain).every((id) => v.bundleState(id) !== "loading");

/** The scope (the chain's last) has no outline and none is on its way. */
export function geometryKnownAbsent(v: OutlineView, chain: readonly RuleUnit[]): boolean {
  const u = chain[chain.length - 1];
  if (!u || raisedGeometryFor(v, u)) return false;
  return v.failed(u.id) || bundlesSettled(v, chain);
}

export function scopePendingFiles(v: OutlineView, chain: readonly RuleUnit[], micro: boolean) {
  const s = chain[chain.length - 1];
  if (micro || !s || s.levelKey === "world") return false;
  return raisedOutlineDue(v, s) || (!raisedGeometryFor(v, s) && !geometryKnownAbsent(v, chain));
}

/** Every geometry the outline will get is in: not pending, the chain settled
 *  (a refinement batch is not waited for). */
export const outlineReadyFiles = (v: OutlineView, chain: readonly RuleUnit[], micro: boolean) =>
  micro || (!scopePendingFiles(v, chain, micro) && bundlesSettled(v, chain));

const meets = (a: Bounds, b: Bounds) =>
  a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLng <= b.maxLng && a.maxLng >= b.minLng;

/** Rule 4's batch: the siblings meeting the scope's box whose self is cut at
 *  another tier than their entry (their parent's), and `crossRegion` (no
 *  entry drawn); not stored, not failed, declared; nearest first, capped. */
export function refinementBatch(
  v: OutlineView,
  scope: RuleUnit,
  siblings: readonly RuleUnit[],
  crossRegion: readonly RuleUnit[],
  caps: { region: number; dep: number } = REFINE_CAPS,
): string[] {
  const cap = scope.levelKey === "region" ? caps.region : scope.levelKey === "dep" ? caps.dep : 0;
  const st = (id: string | null) => (id ? v.rowOf(id)?.st : undefined);
  const tierDiffers = (u: RuleUnit) =>
    st(u.id) !== undefined && st(u.parentId) !== undefined && st(u.id) !== st(u.parentId);
  const picks = new Map<string, RuleUnit>();
  for (const u of [
    ...siblings.filter((u) => meets(u.bounds, scope.bounds) && tierDiffers(u)),
    ...crossRegion,
  ])
    if (u.id !== scope.id && declaresSelf(v, u.id) && !v.selfOf(u.id) && !v.failed(u.id))
      picks.set(u.id, u);
  const [lat0, lng0] = scope.center;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const far = (u: RuleUnit) => (u.center[0] - lat0) ** 2 + ((u.center[1] - lng0) * k) ** 2;
  return [...picks.values()]
    .sort((a, b) => far(a) - far(b))
    .slice(0, cap)
    .map((u) => u.id);
}

/** The deepest unit whose loaded geometry holds the point (its box first). */
export function finestAtIn<U extends RuleUnit>(
  units: readonly U[],
  geometryOf: (u: U) => unknown,
  boxOf: (u: U) => Bounds | undefined,
  contains: (geometry: unknown, lat: number, lng: number) => boolean,
  lat: number,
  lng: number,
): U | null {
  let hit: U | null = null;
  for (const u of units) {
    if (hit && u.depth <= hit.depth) continue;
    const g = geometryOf(u);
    const b = g ? boxOf(u) : undefined;
    if (!b || lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) continue;
    if (contains(g, lat, lng)) hit = u;
  }
  return hit;
}

/** What the explorer asks of a unit's outline. */
export interface OutlineAnswers<U> {
  geometryFor(u: U): unknown;
  raisedGeometryFor(u: U): unknown;
  raisedOutlineDue(u: U): boolean;
  geometryKnownAbsent(u: U): boolean;
}

/** The same questions, answered by the files while they are read (mode
 *  "fichiers"), by the API's stores (`api`) otherwise (rule 5). */
export function outlineRules<U extends RuleUnit>(
  v: OutlineView,
  api: OutlineAnswers<U>,
  chainOf: (u: U) => readonly RuleUnit[],
): OutlineAnswers<U> {
  const on = () => v.mode === "fichiers";
  return {
    geometryFor: (u) => (on() ? geometryFor(v, u) : api.geometryFor(u)),
    raisedGeometryFor: (u) => (on() ? raisedGeometryFor(v, u) : api.raisedGeometryFor(u)),
    raisedOutlineDue: (u) => (on() ? raisedOutlineDue(v, u) : api.raisedOutlineDue(u)),
    geometryKnownAbsent: (u) =>
      on() ? geometryKnownAbsent(v, chainOf(u)) : api.geometryKnownAbsent(u),
  };
}
