// The seed's French places, as the API would store them (map phase 1):
// fr-units.json, the geo_units rows the French seed rows reference, root first;
// fr-places.json, the place columns of every French seed lieu and online town
// hall. Built once, with the network, by build-fixtures.ts; committed, so that
// the seed (generate.ts) and CI need none.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  getCanonicalLocation,
  getKnownCoordinates,
  LOCATION_RULES,
  type PlaceCandidate,
} from "@ac/shared";

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

/** An online bucket's `place`, as the online form files it (resolveTownHall). */
export interface TownHallPlace {
  insee: string;
  commune: string;
  arrondissement: string | null;
  departementCode: string;
  departementName: string;
  region: string;
  lat: number;
  lng: number;
}

/** An online town hall's place columns, as submit_online_testimony sets them (its point is its `place`'s). */
export interface FrOnlinePlace {
  /** The town hall's label: the bucket's location and lieu key. */
  location: string;
  place: TownHallPlace;
  place_unit: string;
  place_path: string[];
  locality_id: string | null;
  /** address: the town hall's own point; commune: the commune's centre. */
  place_precision: "address" | "commune";
  geo_release: string;
}

export interface FrPlaces {
  /** The LOCATION_RULES hash the lieux were placed under (the seed stamps the current one: placeOutdated). */
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

/**
 * The API's rulesHash() (apps/api/src/modules/places/placeLieu.ts), which
 * build-fixtures.ts checks it equals: the rules a placement stands under now.
 */
export const RULES_HASH = createHash("sha256")
  .update(JSON.stringify(LOCATION_RULES))
  .digest("hex")
  .slice(0, 8);

/**
 * Why a fixture lieu no longer holds under the current LOCATION_RULES, or
 * null: the placement job's rules pass (placementJob.ts) places a row again
 * when its lieu name or curated point changed, and only stamps the new rules
 * on any other. The seed does the same, so only a change that moves a seed
 * lieu needs the fixtures built again.
 */
export function placeOutdated(location: string, p: FrPlace): string | null {
  const key = getCanonicalLocation(location);
  if (key !== p.lieu_key) return `lieu "${p.lieu_key}" in the fixture, "${key}" now`;
  const known = getKnownCoordinates(key);
  if (known && (p.lat !== known[0] || p.lng !== known[1])) {
    return `at ${p.lat}, ${p.lng} in the fixture, its rule says ${known[0]}, ${known[1]} now`;
  }
  return null;
}
