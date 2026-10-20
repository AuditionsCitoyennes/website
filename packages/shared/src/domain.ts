import type { Tables, Enums } from "./database.types";

// ---- Row aliases -----------------------------------------------------------

export type Audition = Tables<"auditions">;
export type Testimony = Tables<"testimonies">;
export type UserRole = Tables<"user_roles">;
export type AuditLogEntry = Tables<"audit_log">;

export type AppRole = Enums<"app_role">;
export type AuditionStatus = Enums<"audition_status">;

// Audition enriched with its testimonies / counts (API response shape).
export interface AuditionWithTestimonies extends Audition {
  testimonies: Testimony[];
}

export interface AuditionWithCount extends Audition {
  testimony_count: number;
}

/** Public testimony shape (subset of columns) joined with its audition. */
export interface PublicTestimony {
  id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  topics: string[] | null;
  verification_status: string | null;
  created_at: string | null;
  audition: {
    id: string;
    title: string;
    location: string;
    date: string;
  } | null;
}

/**
 * One audition as a super admin previews it from the audit log: whatever its
 * status, with its testimonies — never their email or verification token.
 */
export interface AuditionPreview {
  id: string;
  title: string;
  date: string;
  location: string;
  content: string;
  status: string | null;
  created_at: string | null;
  testimonies: Omit<PublicTestimony, "audition">[];
}

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
  auditions: AuditionWithCount[];
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

// ---- Admin RPC shapes --------------------------------------------------------

export interface PendingRegistration {
  user_id: string;
  email: string;
  // NULL when the metadata key is absent (e.g. OAuth signups that never
  // completed the username prompt).
  username: string | null;
  bio: string | null;
  created_at: string;
}

export interface RoleWithDetails {
  id: string;
  user_id: string;
  role: AppRole;
  created_at: string;
  email: string | null;
  username: string | null;
}

/**
 * Every action the audit log records. The API writes these names and the admin
 * page labels them — one list, so a new action cannot be logged without the
 * page knowing what to call it.
 */
export const AUDIT_ACTIONS = [
  // Accounts and roles
  "registration_approved",
  "registration_declined",
  "role_deleted",
  "account_deleted",
  // Auditions
  "audition_created",
  "audition_updated",
  "audition_deleted",
  // Testimonies, by an administrator
  "testimony_created",
  "testimony_updated",
  "testimony_deleted",
  // Testimonies, by the witness through the emailed verification link
  "testimony_verified",
  "testimony_rejected",
  // Testimonies, by a visitor through the site's "Témoigner" form
  "testimony_submitted",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditLogRow {
  id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  user_email: string | null;
}

// ---- AI analysis -----------------------------------------------------------

/** Model used to tag testimonies with themes (ported from the old edge function). */
export const ANALYSIS_MODEL = "claude-haiku-4-5-20251001";

/** The exact, closed set of themes Claude may assign. Order matches the prompt. */
export const AUDITION_THEMES = [
  "Santé et accès aux soins",
  "Éducation",
  "Emploi et conditions de travail",
  "Logement",
  "Pouvoir d'achat et inflation",
  "Retraites",
  "Justice sociale et inégalités",
  "Démocratie et institutions",
  "Médias et information",
  "Sécurité et police",
  "Immigration",
  "Environnement et écologie",
  "Guerre et géopolitique",
  "Services publics",
  "Fiscalité",
  "Culture et loisirs",
] as const;

export type AuditionTheme = (typeof AUDITION_THEMES)[number];

// ---- Geography -------------------------------------------------------------

/** Map default center (metropolitan France). */
export const FRANCE_CENTER: [number, number] = [46.603354, 1.888334];

/**
 * Normalize a location string: trim, collapse whitespace, title-case.
 * Handles hyphenated words (e.g. "gratte-ciel" -> "Gratte-Ciel").
 */
export function normalizeLocation(location: string): string {
  const trimmed = location.trim().replace(/\s+/g, " ");
  if (!trimmed) return trimmed;

  return trimmed
    .toLowerCase()
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
        .join("-"),
    )
    .join(" ");
}

/**
 * Keyword rules mapping location variations to canonical names + coordinates.
 * First matching rule wins, so more specific rules come first.
 */
export const LOCATION_RULES: {
  keywords: string[];
  canonical: string;
  coordinates: [number, number];
}[] = [
  {
    keywords: ["gratte-ciel", "villeurbanne"],
    canonical: "Marché des Gratte-Ciel, Villeurbanne",
    coordinates: [45.7676, 4.8799],
  },
  {
    keywords: ["gratte-ciel"],
    canonical: "Marché des Gratte-Ciel, Villeurbanne",
    coordinates: [45.7676, 4.8799],
  },
  {
    keywords: ["charpennes", "villeurbanne"],
    canonical: "Marché des Charpennes, Villeurbanne",
    coordinates: [45.771, 4.8633],
  },
  {
    keywords: ["charles hernu"],
    canonical: "Marché des Charpennes, Villeurbanne",
    coordinates: [45.771, 4.8633],
  },
  { keywords: ["part-dieu"], canonical: "Part-Dieu, Lyon", coordinates: [45.7606, 4.859] },
  {
    keywords: ["croix-rousse"],
    canonical: "Marché de la Croix-Rousse, Lyon",
    coordinates: [45.7743, 4.8316],
  },
  {
    keywords: ["manif", "jean macé"],
    canonical: "Manif Interfac Jean Macé, Lyon 7",
    coordinates: [45.7456, 4.8422],
  },
  {
    keywords: ["jean macé"],
    canonical: "Marché Jean Macé, Lyon 7",
    coordinates: [45.7456, 4.8422],
  },
  {
    keywords: ["grandclément"],
    canonical: "Place Grandclément, Villeurbanne",
    coordinates: [45.766, 4.887],
  },
  {
    keywords: ["granclément"],
    canonical: "Place Grandclément, Villeurbanne",
    coordinates: [45.766, 4.887],
  },
  {
    keywords: ["médiathèque", "bron"],
    canonical: "Parvis Médiathèque, Bron",
    coordinates: [45.7387, 4.9127],
  },
  { keywords: ["bron"], canonical: "Parvis Médiathèque, Bron", coordinates: [45.7387, 4.9127] },
  { keywords: ["cordeliers"], canonical: "Cordeliers, Lyon", coordinates: [45.764, 4.8357] },
  // BAN has no POI for the park; without this it matches "Rue Sergent Blandan"
  // in Lyon 1 (~2.7 km off). Parc Sergent Blandan is in Lyon 7.
  { keywords: ["blandan"], canonical: "Parc Blandan, Lyon", coordinates: [45.7452, 4.8546] },
];

/** Map a raw location string to its canonical form (or the normalized string). */
export function getCanonicalLocation(raw: string): string {
  const normalized = normalizeLocation(raw);
  const lower = normalized.toLowerCase();
  for (const rule of LOCATION_RULES) {
    if (rule.keywords.every((kw) => lower.includes(kw))) return rule.canonical;
  }
  return normalized;
}

/** Hardcoded coordinates for a canonical location, or null (caller geocodes). */
export function getKnownCoordinates(canonicalName: string): [number, number] | null {
  const rule = LOCATION_RULES.find((r) => r.canonical === canonicalName);
  return rule?.coordinates ?? null;
}

/**
 * Generic, non-mappable location values (e.g. the "Anciens témoignages"
 * nationwide bucket). These have no coordinates or administrative area: the API
 * skips geocoding them and the UI shows them as a "Sans lieu précis" node.
 */
export const GENERIC_LOCATION = /^(france|métropole|metropole|en ligne|internet|divers|inconnu)$/i;

/** Whether a (raw or canonical) location is a generic, non-mappable value. */
export function isGenericLocation(location: string): boolean {
  return GENERIC_LOCATION.test(location.trim());
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
