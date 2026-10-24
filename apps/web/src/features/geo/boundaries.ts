// Real boundary geometry laid over the data-derived hierarchy.

import { boundsCenter, unionBounds } from "./bounds";
import type { GeoUnit, LevelKey, UnitGeo } from "./types";

/** A département's INSEE code ("94", "2B", "976"), read off its id; undefined
 *  for any other level. */
export function depCodeOf(u: GeoUnit): string | undefined {
  if (u.levelKey !== "dep") return undefined;
  const key = u.id.slice(u.id.lastIndexOf("/") + 1);
  return key.startsWith("d:") ? key.slice(2) : undefined;
}

/**
 * Override units' data-derived centre/extent with real boundary geometry where
 * available. Régions/départements match by display name (nom); villes/
 * arrondissements match by INSEE code (`byInsee`); a département's own outline
 * (`byDep`, by its code) wins over its france-geojson one. Mutates the units in
 * place.
 *
 * A unit left with no geometry (below the country) then spans what its
 * children do, once THEIRS are real: its box was built from its children's
 * before any boundary came in, and an overseas région (france-geojson has the
 * métropole only) kept the 2.6 km box of its one lieu while the commune around
 * it spans 7 km — fitted to the commune, the région was too small a part of the
 * view to hold, and the scope stopped at France.
 */
export function applyBoundaries(
  index: Map<string, GeoUnit>,
  byNom: Partial<Record<LevelKey, Map<string, UnitGeo>>>,
  byInsee?: Map<string, UnitGeo>,
  byDep?: Map<string, UnitGeo>,
): void {
  const placed = new Set<GeoUnit>();
  for (const u of index.values()) {
    // Places keep their exact point coords — only ville/arrondissement units take
    // boundary geometry (and they share their commune's INSEE with their places).
    const byCode =
      (u.levelKey === "city" || u.levelKey === "arr") && u.insee
        ? byInsee?.get(u.insee)
        : undefined;
    const dep = u.levelKey === "dep" ? byDep?.get(depCodeOf(u) ?? "") : undefined;
    const geo = dep ?? byNom[u.levelKey]?.get(u.label) ?? byCode;
    if (geo) {
      u.center = geo.center;
      u.bounds = geo.bounds;
      placed.add(u);
    }
  }
  const span = (u: GeoUnit): void => {
    u.children.forEach(span);
    if (placed.has(u) || !u.children.length) return;
    if (u.levelKey === "world" || u.levelKey === "country" || u.levelKey === "place") return;
    u.bounds = unionBounds(u.children.map((c) => c.bounds));
    u.center = boundsCenter(u.bounds);
  };
  for (const u of index.values()) if (!u.parentId) span(u);
}

/** Ray-cast point-in-polygon for a GeoJSON Polygon/MultiPolygon (coords [lng,lat]).
 *  Used to disambiguate which unit a map point actually falls in. */
export function geometryContains(geom: unknown, lat: number, lng: number): boolean {
  const g = geom as { type?: string; coordinates?: unknown } | undefined;
  if (!g?.type) return false;
  const polys = (
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
  ) as number[][][][];
  let inside = false;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}
