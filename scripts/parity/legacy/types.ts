// FROZEN — the reference of npm run db:parity (scripts/parity): a copy of
// apps/web/src/features/geo/types.ts
// as of b3cb304, before map phase 1 moved the Témoignages map onto the
// server. Never edited to follow the app; only to run in Node (imports, Vue
// refs turned into arguments).

// The geo model's shapes: the administrative levels, a bounding box, a unit of
// the hierarchy and a unit's real geometry.

export type LevelKey = "world" | "country" | "region" | "dep" | "city" | "arr" | "place";

// Depth = index in this list (monde = 0 … lieu = 6).
export const LEVELS: LevelKey[] = ["world", "country", "region", "dep", "city", "arr", "place"];

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface GeoUnit {
  id: string; // path-encoded, e.g. "France/r:Bretagne/d:35"
  depth: number; // 0 world … 6 place
  levelKey: LevelKey;
  label: string;
  parentId: string | null;
  count: number;
  center: [number, number]; // [lat, lng]
  bounds: Bounds;
  children: GeoUnit[];
  /** Leaf places only: the canonical location name (joins back to auditions). */
  canonical?: string;
  /** INSEE code of a commune (ville) or arrondissement municipal — the join key
   *  to fetch its boundary geometry. Undefined for levels above ville. */
  insee?: string;
}

/** A unit's real geometry-derived centre + extent (from the boundaries endpoint). */
export interface UnitGeo {
  center: [number, number];
  bounds: Bounds;
}
