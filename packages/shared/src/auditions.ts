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
  /** Where the lieu is stored, root first ({FR, fr:reg:84, fr:dep:69, …}); null when it is not stored yet. */
  unitPath?: string[] | null;
  /** The lieu's id (auditions.lieu_id); null when it is not stored yet. */
  lieuId?: string | null;
}

/**
 * How precisely the Témoignages map places a lieu: at a point, its commune,
 * only its département or région — or nowhere. "unplaced": no place by that
 * name, or same-named communes the other lieux did not settle; "pending":
 * never looked up yet (it is being, in the background).
 */
export type LieuPlacement =
  "address" | "commune" | "departement" | "region" | "unplaced" | "pending";

/** One of the same-named communes an unplaced lieu may mean: Saint-Denis (93). */
export interface LieuCandidate {
  name: string;
  departementCode: string | null;
}

/**
 * One of the same-named communes a lieu's name was found to mean, as stored
 * with the audition (auditions.place_candidates): enough to settle it later
 * without asking the geocoder again, and to tell the admins which they are.
 */
export interface PlaceCandidate extends LieuCandidate {
  /** INSEE code of the commune or arrondissement. */
  citycode: string | null;
  arrondissement: string | null;
  departementName: string | null;
  region: string | null;
  lat: number;
  lng: number;
  /** A point found in that commune, or the commune itself. */
  level: "address" | "commune" | "departement" | "region";
  population: number | null;
}

/** BAN's result types, as an admin picks one (housenumber, street, lieu-dit, commune). */
export const BAN_PICK_TYPES = ["housenumber", "street", "locality", "municipality"] as const;

/** An address an admin picked from the BAN suggestions: the audition is placed there. */
export interface BanPick {
  kind: "ban";
  /** INSEE code of the commune (or arrondissement) BAN files it under. */
  citycode: string;
  lat: number;
  lng: number;
  type: (typeof BAN_PICK_TYPES)[number];
}

/** A place picked from the world gazetteer (abroad; arrives with the places picker). */
export interface GazetteerPick {
  kind: "gazetteer";
  country: string;
  unit_id: string;
  chunk: number;
}

/** What an admin picked for an audition's lieu, beside its text. */
export type PlacePick = BanPick | GazetteerPick;

/** Région, département, ville, lieu: the places the Témoignages map files an audition under (admin list). */
export interface AuditionArea {
  canonicalName: string;
  city: string | null;
  departementCode: string | null;
  departementName: string | null;
  region: string | null;
  placement: LieuPlacement;
  /** For an unplaced lieu several communes answer to: those communes. */
  candidates?: LieuCandidate[];
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
