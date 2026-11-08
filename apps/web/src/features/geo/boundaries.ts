// Real boundary geometry laid over the data-derived hierarchy: the outline
// files' rows (geo-nav's useGeoHierarchy hands them in by unit id) frame the
// régions, départements and communes, and the countries but France
// (outlineRoles); without them a unit keeps its data-derived frame.

import { boundsCenter, unionBounds } from "./bounds";
import type { GeoUnit, UnitGeo } from "./types";

/** The unit is French (a French ville's code is its INSEE code). */
function isFrench(u: GeoUnit): boolean {
  return u.geoRef?.country === "FR";
}

/** The INSEE code of a French ville or arrondissement, the units a commune
 *  contour can hold; undefined for any other unit (or a ville whose lieux
 *  disagree on it). */
export function communeCodeOf(u: GeoUnit): string | undefined {
  return (u.levelKey === "city" || u.levelKey === "arr") && isFrench(u) ? u.insee : undefined;
}

/** France itself (its constant frame stays). */
const isFrance = (u: GeoUnit) => u.geoRef?.country === "FR" && u.geoRef.code === "FR";

/**
 * Override units' data-derived centre/extent with their row's where one is
 * known: `byId`, the outline files' rows by unit id, frames the régions, the
 * départements and the communes, and the other countries (but one spanning
 * half the world or more) — never France, which keeps its constant frame,
 * nor the world, which then spans its children. Mutates the units in place.
 *
 * A unit left with no geometry (below the country) then spans what its
 * children do, once THEIRS are real: its box was built from its children's
 * before any boundary came in, and an overseas région with no outline kept
 * the 2.6 km box of its one lieu while the commune around it spans 7 km —
 * fitted to the commune, the région was too small a part of the view to
 * hold, and the scope stopped at France.
 */
export function applyBoundaries(
  index: Map<string, GeoUnit>,
  { byId }: { byId?: Map<string, UnitGeo> },
): void {
  const placed = new Set<GeoUnit>();
  for (const u of index.values()) {
    // Places keep their exact point coords — only ville/arrondissement units take
    // boundary geometry (and they share their commune's INSEE with their places).
    // The country France keeps its constant frame.
    let geo: UnitGeo | undefined;
    switch (u.levelKey) {
      case "region":
      case "dep":
      case "city":
      case "arr":
        geo = byId?.get(u.id);
        break;
      case "country":
        if (!isFrance(u)) {
          const row = byId?.get(u.id);
          if (row && row.bounds.maxLng - row.bounds.minLng < 180) geo = row;
        }
        break;
    }
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
  // The world spans its children once a country is framed by its row: it was
  // the union of their lieux' boxes, and a world fit on that would leave a
  // real country box (Spain's, the Canaries in) over the scope's descent line.
  for (const u of index.values()) {
    if (u.levelKey !== "world" || !u.children.some((c) => placed.has(c))) continue;
    u.bounds = unionBounds(u.children.map((c) => c.bounds));
    u.center = boundsCenter(u.bounds);
  }
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
