import type { Tables, Enums } from "./database.types";

// ---- Row aliases -----------------------------------------------------------

export type Audition = Tables<"auditions">;
/** Where an audition is filed (map phase 1): written by the API, the backfill
 *  and the seed, never by the old app; place_stale and lieu_id are generated. */
export type AuditionPlaceColumn =
  | "place_unit"
  | "place_path"
  | "locality_id"
  | "lieu_key"
  | "lat"
  | "lng"
  | "place_precision"
  | "place_candidates"
  | "placed_location"
  | "placed_rules"
  | "geo_release"
  | "place_stale"
  | "lieu_id";
export type AuditionPlace = Pick<Audition, AuditionPlaceColumn>;
/** A unit auditions are filed under (geo_units: server only). */
export type GeoUnit = Tables<"geo_units">;
/** The columns the database derives from a testimony (trigger
 *  testimonies_derive) for its own counts and search: no app reads or writes them. */
export type TestimonyDerivedColumn =
  "search_text" | "theme_mask" | "themes_approx" | "untagged" | "derive_version";
export type Testimony = Omit<Tables<"testimonies">, TestimonyDerivedColumn>;
/**
 * A testimony as the admin screens get it: email included, never the
 * verification token (only the witness's link carries it).
 */
export type AdminTestimony = Omit<Testimony, "verification_token">;
export type UserRole = Tables<"user_roles">;
export type AuditLogEntry = Tables<"audit_log">;

export type AppRole = Enums<"app_role">;
export type AuditionStatus = Enums<"audition_status">;
