// One hierarchy, both nav models read from it, enriched with real geometry:
// the outline files' (outlineRules.ts) — their rows' centres and extents, the
// polygons a unit is drawn, framed and hit with, whether it has none to wait
// for, and whether a unit holds a point. The hierarchy is the corpus' (the
// map's groups), or the server's tree (map phase 1). The files are read under
// the server's tree only (`outlines`, GeoNav); without them (the corpus, the
// comparer) or once the session falls back, every unit is known absent.
import { computed, type ComputedRef, type Ref } from "vue";
import type { LocationGroup } from "@ac/shared";
import {
  applyBoundaries,
  buildGeoHierarchy,
  buildTreeFromUnits,
  communeCodeOf,
  geometryContains,
  rowKnownAbsent,
  type GeoUnit,
  type UnitGeo,
  type UnitTreeData,
} from "@/features/geo";
import { perfOn, perfSpan } from "@/shared/perf/perf";
import type { UnitTree } from "../data/useUnitTree";
import type { OutlineFiles } from "../data/useOutlineFiles";
import {
  containsPointIn,
  finestAtIn,
  geometryFor as filesGeometryFor,
  NO_FILES,
  outlineRules,
  type OutlineView,
} from "./outlineRules";

export interface GeoHierarchyInputs {
  groups: Ref<LocationGroup[]>;
  /** The server's tree: the hierarchy is built from it, not from `groups`. */
  unitTree?: UnitTree | null;
  /** The outline files (GeoNav: under the server's tree); null: none read. */
  outlines: OutlineFiles | null;
}

const NO_UNITS: UnitTreeData = { units: new Map(), lieux: new Map() };

export function useGeoHierarchy(inputs: GeoHierarchyInputs) {
  const { groups, outlines } = inputs;
  const unitTree = inputs.unitTree ?? null;
  /** The files as the rules read them; null: none read. */
  const view: OutlineView | null = outlines && {
    get mode() {
      return outlines.mode.value;
    },
    rowOf: outlines.rowOf,
    selfOf: outlines.selfOf,
    globeOf: outlines.globeOf,
    unitsOf: outlines.unitsOf,
    bundleState: outlines.bundleState,
    failed: (id) => outlines.isFailed("k", id) || outlines.isFailed("u", id),
    gaveUp: (id) =>
      outlines.heldOut.value.has(id) || outlines.isGaveUp("u", id) || outlines.isGaveUp("k", id),
  };
  /** The outline files are read (none read, or the session fell back: not). */
  const filesActive = () => view !== null && view.mode === "fichiers";

  /** Every unit's frame from its row, once the row is known (root.json's,
   *  or an entry's once its parent's bundle is in); France keeps its own
   *  (applyBoundaries), a row known absent frames nothing (outlineRoles). */
  function rowFrames(index: Map<string, GeoUnit>): Map<string, UnitGeo> {
    void outlines!.version.value;
    const m = new Map<string, UnitGeo>();
    for (const u of index.values()) {
      if (u.levelKey === "world" || u.levelKey === "place") continue;
      const row = outlines!.rowOf(u.id);
      if (row && !rowKnownAbsent(row)) m.set(u.id, { center: row.center, bounds: row.bounds });
    }
    return m;
  }

  const hierarchy = computed(() => {
    const end = perfOn ? perfSpan("vue.hierarchy") : null;
    const h = unitTree
      ? buildTreeFromUnits(unitTree.data() ?? NO_UNITS)
      : buildGeoHierarchy(groups.value);
    applyBoundaries(h.index, filesActive() ? { byId: rowFrames(h.index) } : {});
    if (end) end({ units: h.index.size });
    return h;
  });
  const root: ComputedRef<GeoUnit> = computed(() => hierarchy.value.root);
  const index: ComputedRef<Map<string, GeoUnit>> = computed(() => hierarchy.value.index);

  /** A unit's ancestors, root first, then the unit (the files' chain). */
  const chainOf = (u: GeoUnit): GeoUnit[] => [
    ...u.ancestors.flatMap((id) => index.value.get(id) ?? []),
    u,
  ];
  // The polygon a unit is drawn and hit with, the one it is raised with,
  // whether its plateau waits for it, whether none will come: the files'
  // (outlineRules), or none at all when no file is read.
  const { geometryFor, raisedGeometryFor, raisedOutlineDue, geometryKnownAbsent } = view
    ? outlineRules(view, chainOf)
    : NO_FILES;

  // Real polygon containment, used to break bbox ties in the scope walk (e.g. Lyon 3e
  // vs neighbouring Villeurbanne). Returns false when the unit's geometry isn't loaded
  // yet — the walk then falls back to bbox + nearest-centre.
  //
  // A unit above the commune level holds a point exactly when it holds the
  // deepest loaded commune / arrondissement whose contour does; only where
  // none does is its own outline asked (inside its box: the box is that
  // outline's). Coarser outlines above the commune can cross a commune
  // (Saint-Mandé lay 99% inside a ~3 km-simplified Paris département); the
  // outline files' levels are cut from one Etalab run and meet exactly, so
  // there the rule changes nothing, and it stays.
  function containsPoint(u: GeoUnit, lat: number, lng: number): boolean {
    return containsPointIn(u, finestAt, raisedGeometryFor, geometryContains, lat, lng);
  }
  /** Villes and arrondissements that can have a contour. */
  const communeUnits = computed(() =>
    [...index.value.values()].filter((u) => communeCodeOf(u) !== undefined),
  );
  // A fit asks the same point of every unit down a chain, and of their rivals.
  let finestMemo: {
    lat: number;
    lng: number;
    units: GeoUnit[];
    version: number;
    hit: GeoUnit | null;
  } | null = null;
  /** The deepest ville / arrondissement whose loaded contour holds the point
   *  (none without the files). */
  function finestAt(lat: number, lng: number): GeoUnit | null {
    if (!filesActive()) return null;
    const version = outlines!.version.value;
    const units = communeUnits.value;
    const m = finestMemo;
    const same = m && m.lat === lat && m.lng === lng && m.units === units;
    if (same && m.version === version) return m.hit;
    // Their entries in their parent's bundle, framed by their rows.
    const at = (u: GeoUnit) => filesGeometryFor(view!, u);
    const box = (u: GeoUnit) => outlines!.rowOf(u.id)?.bounds;
    const hit = finestAtIn(units, at, box, geometryContains, lat, lng);
    finestMemo = { lat, lng, units, version, hit };
    return hit;
  }

  // Every lieu in the dataset. Walking the whole index is O(all units) and the
  // view is emitted ~4×/s while panning — so extract the leaves ONCE per
  // hierarchy change, and only run the (cheap, numeric) bounds filter per view
  // (useMapFeed's placesInView).
  const allPlaceUnits = computed<GeoUnit[]>(() =>
    [...index.value.values()].filter((u) => u.levelKey === "place"),
  );

  /** A lieu's unit by its canonical name (its label, for the panel's lines and
   *  the analyses). */
  const placeByCanonical = computed(() => {
    const map = new Map<string, GeoUnit>();
    for (const u of allPlaceUnits.value) if (u.canonical) map.set(u.canonical, u);
    return map;
  });

  /** A lieu's unit id by its canonical name (PanelAudition.placeId). The same
   *  Map while the ids are: the hierarchy is rebuilt as each contour arrives,
   *  its lieux keeping their ids, and a fresh Map would redo every list. */
  let lastPlaceIds = new Map<string, string>();
  const placeIdByCanonical = computed(() => {
    const next = new Map<string, string>();
    for (const [canonical, u] of placeByCanonical.value) next.set(canonical, u.id);
    const same =
      next.size === lastPlaceIds.size &&
      [...next].every(([canonical, id]) => lastPlaceIds.get(canonical) === id);
    if (!same) lastPlaceIds = next;
    return lastPlaceIds;
  });

  return {
    filesActive,
    /** The outline files as the rules read them (null: none read). */
    outlineView: view,
    chainOf,
    hierarchy,
    root,
    index,
    geometryFor,
    geometryKnownAbsent,
    raisedGeometryFor,
    raisedOutlineDue,
    containsPoint,
    finestAt,
    allPlaceUnits,
    placeByCanonical,
    placeIdByCanonical,
  };
}

export type GeoHierarchy = ReturnType<typeof useGeoHierarchy>;
