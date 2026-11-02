// One hierarchy, both nav models read from it, enriched with real geometry:
// the régions' and départements' outlines and centroids, the communes'
// contours and the raised départements' own — France's, for French units only.
// With it, which polygon a unit is drawn, framed and hit with, whether it has
// none to wait for, and whether a unit holds a point. The hierarchy is the
// corpus' (the map's groups), or the server's tree (map phase 1). Under the
// server's tree with ac:contours=fichiers (`outlines`), every one of them is
// answered by the outline files instead (outlineRules.ts) — until the session
// falls back to the API's.
import { computed, toRaw, type ComputedRef, type Ref } from "vue";
import type { LocationGroup } from "@ac/shared";
import {
  applyBoundaries,
  buildGeoHierarchy,
  buildTreeFromUnits,
  communeCodeOf,
  depCodeOf,
  featureFor,
  geometryContains,
  outlineSourceOf,
  type GeoUnit,
  type UnitGeo,
  type UnitTreeData,
} from "@/features/geo";
import { perfOn, perfSpan } from "@/shared/perf/perf";
import type { BoundaryQueries } from "../data/useBoundaryQueries";
import type { CommuneGeo, CommuneGeoStore } from "../data/useCommuneGeo";
import type { DepFineStore } from "../data/useDepFine";
import type { UnitTree } from "../data/useUnitTree";
import type { OutlineFiles } from "../data/useOutlineFiles";
import {
  finestAtIn,
  geometryFor as filesGeometryFor,
  outlineRules,
  type OutlineView,
} from "./outlineRules";

export interface GeoHierarchyInputs {
  groups: Ref<LocationGroup[]>;
  boundaries: BoundaryQueries;
  communes: CommuneGeoStore;
  deps: DepFineStore;
  /** The server's tree: the hierarchy is built from it, not from `groups`. */
  unitTree?: UnitTree | null;
  /** The outline files (GeoNav: the server's tree with ac:contours=fichiers). */
  outlines?: OutlineFiles | null;
}

const NO_UNITS: UnitTreeData = { units: new Map(), lieux: new Map() };

export function useGeoHierarchy(inputs: GeoHierarchyInputs) {
  const { groups, boundaries, communes, deps } = inputs;
  const unitTree = inputs.unitTree ?? null;
  const { regionsQuery, depsQuery, metroQuery, regionLookup, depLookup } = boundaries;
  const { communeGeo, failedInsee, inseeGeo } = communes;
  const { depFine, depGaveUp, depFineGeo } = deps;
  const outlines = inputs.outlines ?? null;
  /** The files as the rules read them; null: the API's outlines only. */
  const view: OutlineView | null = outlines && {
    get mode() {
      return outlines.mode.value;
    },
    rowOf: outlines.rowOf,
    selfOf: outlines.selfOf,
    unitsOf: outlines.unitsOf,
    bundleState: outlines.bundleState,
    failed: (id) => outlines.isFailed("k", id) || outlines.isFailed("u", id),
    gaveUp: (id) =>
      outlines.heldOut.value.has(id) || outlines.isGaveUp("u", id) || outlines.isGaveUp("k", id),
  };
  /** The outline files are read (and the API's are not asked for). */
  const filesActive = () => view !== null && view.mode === "fichiers";

  /** Every unit's frame from its row, once the row is known (root.json's,
   *  or an entry's once its parent's bundle is in). */
  function rowFrames(index: Map<string, GeoUnit>): Map<string, UnitGeo> {
    void outlines!.version.value;
    const m = new Map<string, UnitGeo>();
    for (const u of index.values()) {
      if (u.levelKey === "world" || u.levelKey === "country" || u.levelKey === "place") continue;
      const row = outlines!.rowOf(u.id);
      if (row) m.set(u.id, { center: row.center, bounds: row.bounds });
    }
    return m;
  }

  const hierarchy = computed(() => {
    const end = perfOn ? perfSpan("vue.hierarchy") : null;
    const h = unitTree
      ? buildTreeFromUnits(unitTree.data() ?? NO_UNITS)
      : buildGeoHierarchy(groups.value);
    applyBoundaries(
      h.index,
      filesActive()
        ? { byId: rowFrames(h.index) }
        : {
            regions: regionLookup.value,
            departements: depLookup.value,
            byInsee: inseeGeo.value,
            byDep: depFineGeo.value,
          },
    );
    if (end) end({ units: h.index.size });
    return h;
  });
  const root: ComputedRef<GeoUnit> = computed(() => hierarchy.value.root);
  const index: ComputedRef<Map<string, GeoUnit>> = computed(() => hierarchy.value.index);

  // The boundary polygon for a unit, from its source (outlineSourceOf): the
  // country FR from the métropole contour, régions/départements from the bundled
  // FCs (by code, else nom), villes/arrondissements from the on-demand commune
  // geometry (by INSEE). None for the world, a lieu or a unit outside France.
  function apiGeometryFor(u: GeoUnit): unknown {
    const src = outlineSourceOf(u);
    if (!src) return undefined;
    // toRaw: strip any reactive Proxy before geometry reaches the hot paths
    // (mesh rebuild, scanlines, hit tests) — a no-op on already-plain objects.
    if (src.kind === "metropole") return toRaw(metroQuery.data.value?.features[0]?.geometry);
    if (src.kind === "commune") return toRaw(communeGeo.value[src.insee]?.geometry);
    const fc = src.kind === "regions" ? regionsQuery.data.value : depsQuery.data.value;
    return toRaw(featureFor(fc?.features, src)?.geometry);
  }

  /** The unit has no outline and none is on its way, so nothing to wait for:
   *  no source of France's holds it (the world, a lieu, a unit outside
   *  France), or its source answered without it — a DROM région
   *  (france-geojson's régions are the métropole's), a département with no
   *  france-geojson outline whose own is not waited for, a commune whose
   *  contour fetch gave nothing (failedInsee: a dead code, or a failed batch
   *  until it is retried). Reactive: false again once an outline lands. A
   *  failed collection fetch is no answer (scopePending releases on it). */
  function apiGeometryKnownAbsent(u: GeoUnit): boolean {
    if (raisedGeometryFor(u)) return false;
    const src = outlineSourceOf(u);
    if (!src) return true;
    if (src.kind === "metropole") return !!metroQuery.data.value;
    if (src.kind === "regions") return !!regionsQuery.data.value;
    if (src.kind === "departements") return !!depsQuery.data.value && !raisedOutlineDue(u);
    return failedInsee.value.has(src.insee);
  }

  /** The outline a unit is RAISED with — framed, holding the view's centre:
   *  a département's own (depFine) once loaded, else its geometryFor. */
  function apiRaisedGeometryFor(u: GeoUnit): unknown {
    const code = depCodeOf(u);
    const fine = code ? depFine.value[code] : undefined;
    return fine ? fine.geometry : geometryFor(u);
  }

  /** The scope's plateau waits for its outline: a département whose own is on
   *  its way (or about to be asked for), and not given up on. */
  function apiRaisedOutlineDue(u: GeoUnit): boolean {
    const code = depCodeOf(u);
    return !!code && !depFine.value[code] && !depGaveUp.value.has(code);
  }

  /** A unit's ancestors, root first, then the unit (the files' chain). */
  const chainOf = (u: GeoUnit): GeoUnit[] => [
    ...u.ancestors.flatMap((id) => index.value.get(id) ?? []),
    u,
  ];
  const api = {
    geometryFor: apiGeometryFor,
    raisedGeometryFor: apiRaisedGeometryFor,
    raisedOutlineDue: apiRaisedOutlineDue,
    geometryKnownAbsent: apiGeometryKnownAbsent,
  };
  const { geometryFor, raisedGeometryFor, raisedOutlineDue, geometryKnownAbsent } = view
    ? outlineRules(view, api, chainOf)
    : api;

  // Real polygon containment, used to break bbox ties in the scope walk (e.g. Lyon 3e
  // vs neighbouring Villeurbanne). Returns false when the unit's geometry isn't loaded
  // yet — the walk then falls back to bbox + nearest-centre.
  //
  // Above the commune, the outlines are france-geojson's (country, régions,
  // départements until their own lands), simplified to ~3 km segments — a commune
  // can cross them: Saint-Mandé lies 99% inside the Paris département's. So a
  // unit above the commune level holds a point exactly when it holds the deepest
  // loaded commune / arrondissement whose contour does; only where none does is
  // its own outline asked (inside its box: the box is that outline's). The
  // outline files' levels are cut from one Etalab run and meet exactly, so
  // there the rule changes nothing, and it stays.
  function containsPoint(u: GeoUnit, lat: number, lng: number): boolean {
    if (u.levelKey === "country" || u.levelKey === "region" || u.levelKey === "dep") {
      const hit = finestAt(lat, lng);
      if (hit) return hit.ancestors.includes(u.id);
    }
    const b = u.bounds;
    if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) return false;
    const g = raisedGeometryFor(u);
    return g ? geometryContains(g, lat, lng) : false;
  }
  /** Villes and arrondissements that can have a contour. */
  const communeUnits = computed(() =>
    [...index.value.values()].filter((u) => communeCodeOf(u) !== undefined),
  );
  // A fit asks the same point of every unit down a chain, and of their rivals.
  let finestMemo: {
    lat: number;
    lng: number;
    geo: Record<string, CommuneGeo>;
    units: GeoUnit[];
    version: number;
    hit: GeoUnit | null;
  } | null = null;
  /** The deepest ville / arrondissement whose loaded contour holds the point. */
  function finestAt(lat: number, lng: number): GeoUnit | null {
    const files = filesActive();
    const version = files ? outlines!.version.value : -1;
    const geo = communeGeo.value;
    const units = communeUnits.value;
    const m = finestMemo;
    const same = m && m.lat === lat && m.lng === lng && m.geo === geo && m.units === units;
    if (same && m.version === version) return m.hit;
    if (files) {
      // Their entries in their parent's bundle, framed by their rows.
      const at = (u: GeoUnit) => filesGeometryFor(view!, u);
      const box = (u: GeoUnit) => outlines!.rowOf(u.id)?.bounds;
      const hit = finestAtIn(units, at, box, geometryContains, lat, lng);
      finestMemo = { lat, lng, geo, units, version, hit };
      return hit;
    }
    let hit: GeoUnit | null = null;
    for (const u of units) {
      if (hit && u.depth <= hit.depth) continue;
      const g = geo[u.insee!];
      if (!g) continue;
      const b = g.bounds;
      if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) continue;
      if (geometryContains(g.geometry, lat, lng)) hit = u;
    }
    finestMemo = { lat, lng, geo, units, version, hit };
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
    /** The server's tree is on screen. */
    serverTree: unitTree !== null,
    filesActive,
    /** The outline files as the rules read them (null: the API's only). */
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
