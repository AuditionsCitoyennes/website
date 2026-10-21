import type { Audition, Testimony } from "./db";
import { isGenericLocation } from "./locations";

// Audition enriched with its testimonies / counts (API response shape).
export interface AuditionWithTestimonies extends Audition {
  testimonies: Testimony[];
}

export interface AuditionWithCount extends Audition {
  testimony_count: number;
}

/**
 * An audition as the map carries it in a LocationGroup: what a pin and the
 * lieu's list need — never the text (it comes with the testimonies), the
 * author (a user id), the town hall record or the timestamps.
 */
export type MapAudition = Pick<Audition, "id" | "title" | "date" | "location"> & {
  testimony_count: number;
};

/**
 * Where an online audition's town hall is (auditions.place), resolved from the
 * official commune API when the audition is created.
 */
export interface OnlinePlace {
  /** INSEE code of the town hall's commune or arrondissement (= citycode). */
  insee: string;
  /** The commune: "Villeurbanne", or "Lyon" for one of its arrondissements. */
  commune: string;
  /** "Lyon 7e"-style, for Paris, Lyon and Marseille; null elsewhere. */
  arrondissement: string | null;
  departementCode: string | null;
  departementName: string | null;
  region: string | null;
  lat: number;
  lng: number;
}

/** Published auditions sharing one canonical location, placed on the map. */
export interface LocationGroup {
  canonicalName: string;
  coordinates: [number, number];
  auditions: MapAudition[];
  totalTestimonies: number;
  // Administrative area (from the geocoder) — powers area-based filtering.
  city?: string | null;
  // INSEE code of the finest unit (commune, or arrondissement for Paris/Lyon/
  // Marseille) — the join key for fetching its boundary geometry.
  citycode?: string | null;
  // Arrondissement label for Paris/Lyon/Marseille (e.g. "Lyon 7e"); null elsewhere.
  arrondissement?: string | null;
  departementCode?: string | null;
  departementName?: string | null;
  region?: string | null;
}

/**
 * Where an audition of the association's own comes from: met in the street
 * (terrain), copied from a 2019 cahier de doléances, or the archive of old
 * testimonies with no place of their own. OWN auditions only.
 */
export type AuditionCohort = "terrain" | "cahier2019" | "archive";

const CAHIER_TITLE = /^cahiers? de doléances/i;

/** archive = generic location ("Anciens témoignages", location "France"); cahier2019 = title starts with "Cahier de doléances"; else terrain. OWN auditions only. */
export function auditionCohort(a: { title: string; location: string }): AuditionCohort {
  if (isGenericLocation(a.location)) return "archive";
  if (CAHIER_TITLE.test(a.title.trim())) return "cahier2019";
  return "terrain";
}

/** Own auditions whose date is a placeholder: no date, the archive (2020-12-05), the 2019 cahiers (2019-02-01). Never use on Grand Débat imports (9 real meetings are on 2019-02-01). */
export function isPlaceholderAuditionDate(a: {
  title: string;
  date: string | null;
  location: string;
}): boolean {
  if (!a.date) return true;
  // The cahiers were entered under one stand-in day for the whole Grand Débat;
  // the archive under the day it was imported.
  return auditionCohort(a) !== "terrain";
}
