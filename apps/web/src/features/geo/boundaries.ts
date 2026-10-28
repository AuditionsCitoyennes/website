// Real boundary geometry laid over the data-derived hierarchy. Every outline
// source of phase 1 is French (the métropole contour, france-geojson's régions
// and départements, the départements' own, the communes' contours): a unit
// outside France has none, and is known to have none.

import { boundsCenter, unionBounds } from "./bounds";
import type { GeoUnit, UnitGeo } from "./types";

/** The unit is French: France's outline sources may hold it. */
export function isFrench(u: GeoUnit): boolean {
  return u.geoRef?.country === "FR";
}

/** A French département's INSEE code ("94", "2B", "976"); undefined for any
 *  other unit. */
export function depCodeOf(u: GeoUnit): string | undefined {
  return u.levelKey === "dep" && isFrench(u) ? u.geoRef?.code : undefined;
}

/** The INSEE code a French ville's or arrondissement's contour is fetched by;
 *  undefined for any other unit (or a ville whose lieux disagree on it). */
export function communeCodeOf(u: GeoUnit): string | undefined {
  return (u.levelKey === "city" || u.levelKey === "arr") && isFrench(u) ? u.insee : undefined;
}

/**
 * Where a unit's outline comes from: the métropole contour (the country FR),
 * france-geojson's régions or départements (by code when the unit has one,
 * else by name), or its commune contour (by INSEE code). null: none — no
 * outline will ever come for it (the world, a lieu, any unit outside France):
 * its geometry is known absent, as it is when its source answers without it
 * (geo-nav's geometryKnownAbsent).
 */
export type OutlineSource =
  | { kind: "metropole" }
  | { kind: "regions"; code?: string; nom?: string }
  | { kind: "departements"; code?: string; nom?: string }
  | { kind: "commune"; insee: string };

export function outlineSourceOf(u: GeoUnit): OutlineSource | null {
  const ref = u.geoRef;
  if (ref?.country !== "FR") return null;
  switch (u.levelKey) {
    case "country":
      return ref.code === "FR" ? { kind: "metropole" } : null;
    case "region":
      return { kind: "regions", code: ref.code, nom: ref.nom };
    case "dep":
      return { kind: "departements", code: ref.code, nom: ref.nom };
    case "city":
    case "arr":
      return u.insee ? { kind: "commune", insee: u.insee } : null;
    default:
      return null;
  }
}

/** One france-geojson level's centres and extents, by code and by name. */
export interface LevelLookup {
  byCode: Map<string, UnitGeo>;
  byNom: Map<string, UnitGeo>;
}

/** A région's or a département's feature in a france-geojson collection: by
 *  its code when it has one, else by name. */
export function featureFor<F extends { properties: { code: string; nom: string } }>(
  features: readonly F[] | undefined,
  src: { code?: string; nom?: string },
): F | undefined {
  if (src.code !== undefined) return features?.find((f) => f.properties.code === src.code);
  return src.nom !== undefined ? features?.find((f) => f.properties.nom === src.nom) : undefined;
}

/** A région's or a département's entry: by its code when it has one, else by name. */
function lookUp(
  lookup: LevelLookup | undefined,
  src: { code?: string; nom?: string },
): UnitGeo | undefined {
  if (src.code !== undefined) return lookup?.byCode.get(src.code);
  return src.nom !== undefined ? lookup?.byNom.get(src.nom) : undefined;
}

export interface BoundaryLookups {
  regions?: LevelLookup;
  departements?: LevelLookup;
  /** Villes' and arrondissements' contours, by INSEE code. */
  byInsee?: Map<string, UnitGeo>;
  /** The départements' own outlines (depFine), by code: they win over france-geojson's. */
  byDep?: Map<string, UnitGeo>;
}

/**
 * Override units' data-derived centre/extent with real boundary geometry where
 * available — French units only (outlineSourceOf). Mutates the units in place.
 *
 * A unit left with no geometry (below the country) then spans what its
 * children do, once THEIRS are real: its box was built from its children's
 * before any boundary came in, and an overseas région (france-geojson has the
 * métropole only) kept the 2.6 km box of its one lieu while the commune around
 * it spans 7 km — fitted to the commune, the région was too small a part of the
 * view to hold, and the scope stopped at France.
 */
export function applyBoundaries(index: Map<string, GeoUnit>, lookups: BoundaryLookups): void {
  const { regions, departements, byInsee, byDep } = lookups;
  const placed = new Set<GeoUnit>();
  for (const u of index.values()) {
    // Places keep their exact point coords — only ville/arrondissement units take
    // boundary geometry (and they share their commune's INSEE with their places).
    // The country keeps its constant frame.
    const src = outlineSourceOf(u);
    let geo: UnitGeo | undefined;
    if (src?.kind === "regions") geo = lookUp(regions, src);
    else if (src?.kind === "departements") {
      geo =
        (src.code !== undefined ? byDep?.get(src.code) : undefined) ?? lookUp(departements, src);
    } else if (src?.kind === "commune") geo = byInsee?.get(src.insee);
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
