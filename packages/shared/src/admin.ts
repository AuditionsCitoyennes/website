import type { AppRole } from "./db";
import type { PublicTestimony } from "./testimonies";

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
