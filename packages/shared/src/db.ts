import type { Tables, Enums } from "./database.types";

// ---- Row aliases -----------------------------------------------------------

export type Audition = Tables<"auditions">;
export type Testimony = Tables<"testimonies">;
/**
 * A testimony as the admin screens get it: email included, never the
 * verification token (only the witness's link carries it).
 */
export type AdminTestimony = Omit<Testimony, "verification_token">;
export type UserRole = Tables<"user_roles">;
export type AuditLogEntry = Tables<"audit_log">;

export type AppRole = Enums<"app_role">;
export type AuditionStatus = Enums<"audition_status">;
