// A cross-check of the plan's points against the Etalab contours-administratifs
// (2026, simplified at 50 m) that scripts/map-data downloads into
// ~/.cache/ac-map-data/raw: each point should lie in its leaf unit's polygon
// (commune or arrondissement, département, région). Warnings only — the
// contours are simplified, and a lieu on a border may fall a few metres out.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Ring = [number, number][]; // [lng, lat]
type Polygon = Ring[];

interface Feature {
  properties: { code?: string };
  geometry:
    | { type: "Polygon"; coordinates: Polygon }
    | { type: "MultiPolygon"; coordinates: Polygon[] }
    | null;
}

/** Polygons by unit id (fr:com:, fr:dep:, fr:reg:). */
export type Contours = Map<string, Polygon[]>;

const FILES: [prefix: string, file: string][] = [
  ["fr:com:", "etalab-communes-50m.geojson"],
  ["fr:dep:", "etalab-departements-50m.geojson"],
  ["fr:reg:", "etalab-regions-50m.geojson"],
];

/** The contours in `dir`, or null when its communes file is missing. */
export function loadContours(dir: string): Contours | null {
  if (!existsSync(join(dir, FILES[0][1]))) return null;
  const contours: Contours = new Map();
  for (const [prefix, file] of FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const { features } = JSON.parse(readFileSync(path, "utf8")) as { features: Feature[] };
    for (const f of features) {
      const g = f.geometry;
      if (!f.properties.code || !g) continue;
      contours.set(
        prefix + f.properties.code,
        g.type === "Polygon" ? [g.coordinates] : g.coordinates,
      );
    }
  }
  return contours;
}

/** Even-odd ray casting over every ring (holes included). */
function inPolygon([lng, lat]: [number, number], polygon: Polygon): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Metres from a point to the nearest edge (local equirectangular: fine at these distances). */
function metresToEdge([lng, lat]: [number, number], polygons: Polygon[]): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_540;
  let best = Infinity;
  for (const ring of polygons.flat()) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = (ring[j][0] - lng) * kx;
      const ay = (ring[j][1] - lat) * ky;
      const bx = (ring[i][0] - lng) * kx;
      const by = (ring[i][1] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/** Inside its unit's polygon, outside it (by so many metres), or no polygon for that unit. */
export type ContourCheck =
  { kind: "inside" } | { kind: "outside"; metres: number } | { kind: "unknown" };

/** Whether [lat, lng] lies in the polygon of `unit`. */
export function checkPoint(
  contours: Contours,
  unit: string,
  [lat, lng]: [number, number],
): ContourCheck {
  const polygons = contours.get(unit);
  if (!polygons) return { kind: "unknown" };
  if (polygons.some((p) => inPolygon([lng, lat], p))) return { kind: "inside" };
  return { kind: "outside", metres: Math.round(metresToEdge([lng, lat], polygons)) };
}
