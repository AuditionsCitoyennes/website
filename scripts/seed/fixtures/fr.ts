// The seed's French places, as the API would store them (map phase 1):
// fr-units.json, the geo_units rows the French seed rows reference, root first;
// fr-places.json, the place columns of every French seed lieu and online town
// hall. Built once, with the network, by build-fixtures.ts; committed, so that
// the seed (generate.ts) and CI need none.

import { readFileSync } from "node:fs";
import type { PlaceCandidate } from "@ac/shared";

/** A geo_units row, as the seed inserts it. */
export interface FrUnit {
  id: string;
  parent_id: string | null;
  level: "country" | "region" | "county" | "locality";
  country: string;
  name: string;
  code: string | null;
  lat: number | null;
  lng: number | null;
  source: "insee";
  geo_release: string;
}

/** A lieu's place columns, placed or unplaced after an attempt (placed_location and placed_rules aside). */
export interface FrPlace {
  place_unit: string | null;
  place_path: string[] | null;
  locality_id: string | null;
  lieu_key: string;
  lat: number | null;
  lng: number | null;
  place_precision: "address" | "commune" | "departement" | "region" | "unplaced";
  place_candidates: PlaceCandidate[] | null;
  geo_release: string | null;
}

/** An online town hall's place columns, as submit_online_testimony sets them (its point is the bucket's `place`). */
export interface FrOnlinePlace {
  /** The town hall's label: the bucket's location and lieu key. */
  location: string;
  place_unit: string;
  place_path: string[];
  locality_id: string | null;
  /** address: the town hall's own point; commune: the commune's centre. */
  place_precision: "address" | "commune";
  geo_release: string;
}

export interface FrPlaces {
  /** The LOCATION_RULES hash the lieux were placed under (auditions.placed_rules). */
  rules: string;
  /** The seed's French locations, as typed. */
  lieux: Record<string, FrPlace>;
  /** The online town halls, by INSEE code (the bucket's citycode). */
  online: Record<string, FrOnlinePlace>;
}

export const FR_UNITS_FILE = new URL("./fr-units.json", import.meta.url);
export const FR_PLACES_FILE = new URL("./fr-places.json", import.meta.url);

export function readFrFixtures(): { units: FrUnit[]; places: FrPlaces } {
  return {
    units: JSON.parse(readFileSync(FR_UNITS_FILE, "utf8")) as FrUnit[],
    places: JSON.parse(readFileSync(FR_PLACES_FILE, "utf8")) as FrPlaces,
  };
}
