import type { Tables, Enums } from "./database.types";

// ---- Row aliases -----------------------------------------------------------

export type Audition = Tables<"auditions">;
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
