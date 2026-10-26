// One hierarchy, both nav models read from it, enriched with real geometry:
// the régions' and départements' outlines and centroids, the communes'
// contours and the raised départements' own. With it, which polygon a unit is
// drawn, framed and hit with, and whether a unit holds a point.
import { computed, toRaw, type ComputedRef, type Ref } from "vue";
import type { LocationGroup } from "@ac/shared";
import {
  applyBoundaries,
  buildGeoHierarchy,
  depCodeOf,
  geometryContains,
  type GeoUnit,
} from "@/features/geo";
import { perfOn, perfSpan } from "@/shared/perf/perf";
import type { BoundaryQueries } from "../data/useBoundaryQueries";
import type { CommuneGeo, CommuneGeoStore } from "../data/useCommuneGeo";
import type { DepFineStore } from "../data/useDepFine";

export interface GeoHierarchyInputs {
  groups: Ref<LocationGroup[]>;
  boundaries: BoundaryQueries;
  communes: CommuneGeoStore;
  deps: DepFineStore;
}

export function useGeoHierarchy(inputs: GeoHierarchyInputs) {
  const { groups, boundaries, communes, deps } = inputs;
  const { regionsQuery, depsQuery, metroQuery, regionByNom, depByNom } = boundaries;
  const { communeGeo, inseeGeo } = communes;
  const { depFine, depGaveUp, depFineGeo } = deps;

  const hierarchy = computed(() => {
    const end = perfOn ? perfSpan("vue.hierarchy") : null;
    const h = buildGeoHierarchy(groups.value);
    applyBoundaries(
      h.index,
      { region: regionByNom.value, dep: depByNom.value },
      inseeGeo.value,
      depFineGeo.value,
    );
    if (end) end({ units: h.index.size });
    return h;
  });
  const root: ComputedRef<GeoUnit> = computed(() => hierarchy.value.root);
  const index: ComputedRef<Map<string, GeoUnit>> = computed(() => hierarchy.value.index);

  // Boundary geometry for a set of units: régions/départements from the bundled
  // FCs (by nom), villes/arrondissements from the on-demand commune geometry (by
  // INSEE), the country from the métropole contour. Only the world level has none.
  // The boundary polygon for a unit (régions/deps by nom, villes/arr by INSEE).
  function geometryFor(u: GeoUnit): unknown {
    // toRaw: strip any reactive Proxy before geometry reaches the hot paths
    // (mesh rebuild, scanlines, hit tests) — a no-op on already-plain objects.
    if (u.levelKey === "country") {
      return toRaw(metroQuery.data.value?.features[0]?.geometry);
    }
    if (u.levelKey === "region" || u.levelKey === "dep") {
      const fc = u.levelKey === "region" ? regionsQuery.data.value : depsQuery.data.value;
      return toRaw(fc?.features.find((x) => x.properties.nom === u.label)?.geometry);
    }
    if ((u.levelKey === "city" || u.levelKey === "arr") && u.insee) {
      return toRaw(communeGeo.value[u.insee]?.geometry);
    }
    return undefined;
  }

  /** The outline a unit is RAISED with — framed, holding the view's centre:
   *  a département's own (depFine) once loaded, else its geometryFor. */
  function raisedGeometryFor(u: GeoUnit): unknown {
    const code = depCodeOf(u);
    const fine = code ? depFine.value[code] : undefined;
    return fine ? fine.geometry : geometryFor(u);
  }

  /** The scope's plateau waits for its outline: a département whose own is on
   *  its way (or about to be asked for), and not given up on. */
  function raisedOutlineDue(u: GeoUnit): boolean {
    const code = depCodeOf(u);
    return !!code && !depFine.value[code] && !depGaveUp.value.has(code);
  }

  // Real polygon containment, used to break bbox ties in the scope walk (e.g. Lyon 3e
  // vs neighbouring Villeurbanne). Returns false when the unit's geometry isn't loaded
  // yet — the walk then falls back to bbox + nearest-centre.
  //
  // Above the commune, the outlines are france-geojson's (country, régions,
  // départements until their own lands), simplified to ~3 km segments — a commune
  // can cross them: Saint-Mandé lies 99% inside the Paris département's. So a
  // unit above the commune level holds a point exactly when it holds the deepest
  // loaded commune / arrondissement whose contour does; only where none does is
  // its own outline asked (inside its box: the box is that outline's).
  function containsPoint(u: GeoUnit, lat: number, lng: number): boolean {
    if (u.levelKey === "country" || u.levelKey === "region" || u.levelKey === "dep") {
      const hit = finestAt(lat, lng);
      if (hit) return hit.id.startsWith(`${u.id}/`);
    }
    const b = u.bounds;
    if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) return false;
    const g = raisedGeometryFor(u);
    return g ? geometryContains(g, lat, lng) : false;
  }
  /** Villes and arrondissements that can have a contour. */
  const communeUnits = computed(() =>
    [...index.value.values()].filter(
      (u) => (u.levelKey === "city" || u.levelKey === "arr") && u.insee,
    ),
  );
  // A fit asks the same point of every unit down a chain, and of their rivals.
  let finestMemo: {
    lat: number;
    lng: number;
    geo: Record<string, CommuneGeo>;
    units: GeoUnit[];
    hit: GeoUnit | null;
  } | null = null;
  /** The deepest ville / arrondissement whose loaded contour holds the point. */
  function finestAt(lat: number, lng: number): GeoUnit | null {
    const geo = communeGeo.value;
    const units = communeUnits.value;
    const m = finestMemo;
    if (m && m.lat === lat && m.lng === lng && m.geo === geo && m.units === units) return m.hit;
    let hit: GeoUnit | null = null;
    for (const u of units) {
      if (hit && u.depth <= hit.depth) continue;
      const g = geo[u.insee!];
      if (!g) continue;
      const b = g.bounds;
      if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) continue;
      if (geometryContains(g.geometry, lat, lng)) hit = u;
    }
    finestMemo = { lat, lng, geo, units, hit };
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

  return {
    hierarchy,
    root,
    index,
    geometryFor,
    raisedGeometryFor,
    raisedOutlineDue,
    containsPoint,
    finestAt,
    allPlaceUnits,
    placeByCanonical,
  };
}

export type GeoHierarchy = ReturnType<typeof useGeoHierarchy>;
