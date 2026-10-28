// Boundary geometry: the régions' and départements' outlines (with real
// centroids) and the metropolitan-France contour, each one vue-query query
// kept for the session, plus the code and nom → centre/bounds lookups the
// hierarchy is enriched with. Called synchronously in setup, like every
// vue-query call.
import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/shared/api/client";
import type { Bounds, LevelLookup } from "@/features/geo";

export interface BoundaryFeature {
  type: "Feature";
  geometry: unknown;
  properties: { code: string; nom: string; center: [number, number]; bounds: Bounds };
}
export interface BoundaryFC {
  type: "FeatureCollection";
  features: BoundaryFeature[];
}

export function useBoundaryQueries() {
  const regionsQuery = useQuery({
    queryKey: ["boundaries", "regions"],
    queryFn: () => api.get<BoundaryFC>("/api/boundaries/regions"),
    staleTime: Infinity,
    // shallow: boundary geometry must never be Vue-proxied (the mesh/scanline hot
    // paths iterate millions of coordinates and would pay a trap per access).
    shallow: true,
  });
  const depsQuery = useQuery({
    queryKey: ["boundaries", "departements"],
    queryFn: () => api.get<BoundaryFC>("/api/boundaries/departements"),
    staleTime: Infinity,
    shallow: true,
  });
  // Metropolitan-France contour: the country is a selectable scope like any other
  // unit (its own plateau at world view).
  const metroQuery = useQuery({
    queryKey: ["boundaries", "metropole"],
    queryFn: () => api.get<BoundaryFC>("/api/boundaries/metropole"),
    staleTime: Infinity,
    shallow: true,
  });

  function lookupOf(fc?: BoundaryFC): LevelLookup {
    const lookup: LevelLookup = { byCode: new Map(), byNom: new Map() };
    for (const f of fc?.features ?? []) {
      const geo = { center: f.properties.center, bounds: f.properties.bounds };
      lookup.byCode.set(f.properties.code, geo);
      lookup.byNom.set(f.properties.nom, geo);
    }
    return lookup;
  }
  const regionLookup = computed(() => lookupOf(regionsQuery.data.value));
  const depLookup = computed(() => lookupOf(depsQuery.data.value));

  return { regionsQuery, depsQuery, metroQuery, regionLookup, depLookup };
}

export type BoundaryQueries = ReturnType<typeof useBoundaryQueries>;
