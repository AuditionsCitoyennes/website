import type { Tables, TablesInsert, TablesUpdate, Enums } from "./database.types";

// ---- Row aliases -----------------------------------------------------------

export type Audition = Tables<"auditions">;
/** Where an audition is filed (map phase 1): written by the API, the backfill
 *  and the seed, never by the old app. */
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
  | "geo_release";
/** Generated from the place columns. The generated Insert and Update types
 *  list them, but the database refuses any value (428C9). */
export type AuditionGeneratedColumn = "place_stale" | "lieu_id";
/** An audition's place as read. */
export type AuditionPlace = Pick<Audition, AuditionPlaceColumn | AuditionGeneratedColumn>;
/** A write type that refuses the generated columns, from a spread as well. */
type WithoutGenerated<T> = Omit<T, AuditionGeneratedColumn> & {
  [K in AuditionGeneratedColumn]?: never;
};
/** An audition's place as written. */
export type AuditionPlaceWrite = WithoutGenerated<
  Pick<TablesInsert<"auditions">, AuditionPlaceColumn>
>;
/** An audition insert or update, as an app may send it. */
export type AuditionInsert = WithoutGenerated<TablesInsert<"auditions">>;
export type AuditionUpdate = WithoutGenerated<TablesUpdate<"auditions">>;
/** A unit auditions are filed under (geo_units: server only). */
export type GeoUnit = Tables<"geo_units">;
/** The columns the database derives from a testimony (trigger
 *  testimonies_derive) for its own counts and search: no app reads or writes them. */
export type TestimonyDerivedColumn =
  "search_text" | "theme_mask" | "themes_approx" | "untagged" | "derive_version";
/** Who certified that the witness agreed to publication, and when: written by
 *  the API when a volunteer sends testimonies, read by no screen (neither the
 *  public key nor admin_testimonies() reads them). */
export type TestimonyConsentColumn = "consent_certified_by" | "consent_certified_at";
export type Testimony = Omit<
  Tables<"testimonies">,
  TestimonyDerivedColumn | TestimonyConsentColumn
>;
/**
 * A testimony as the admin screens get it: email included, never the
 * verification token (only the witness's link carries it).
 */
export type AdminTestimony = Omit<Testimony, "verification_token">;
export type UserRole = Tables<"user_roles">;
export type AuditLogEntry = Tables<"audit_log">;

export type AppRole = Enums<"app_role">;
export type AuditionStatus = Enums<"audition_status">;
