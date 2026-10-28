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

/** A unit's level in its country's gazetteer (the database's geo_units.level):
 *  a French département is a county, a commune and an arrondissement localities. */
export type GeoLevel = "country" | "dependency" | "region" | "county" | "localadmin" | "locality";

/** Where a unit sits in its country's gazetteer: what its outline is found by. */
export interface GeoRef {
  /** ISO 3166-1 alpha-2: "FR". */
  country: string;
  level: GeoLevel;
  /** The country's ISO code; in France the région's, département's, commune's
   *  or arrondissement's INSEE code — when known (a région's is not, from the
   *  map groups). */
  code?: string;
  /** Its name, as an outline without a code is matched by. */
  nom?: string;
}

/** How high the unit's plateau rises: "half" for a département, a ville or an
 *  arrondissement, whose fit views sit much closer to the ground (map/lib/polygon). */
export type HeightClass = "full" | "half";

export interface GeoUnit {
  /** Opaque: compared, never read. (The corpus builds it as a path —
   *  "France/r:Bretagne/d:35" — that only the analyses' figures still rely on.) */
  id: string;
  depth: number; // 0 world … 6 place
  levelKey: LevelKey;
  label: string;
  parentId: string | null;
  /** The ids of the units it sits in, root first ("world", the country, …);
   *  none for the root. */
  ancestors: string[];
  /** Where it sits in a gazetteer; none for the world and for a lieu. */
  geoRef?: GeoRef;
  heightClass: HeightClass;
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
