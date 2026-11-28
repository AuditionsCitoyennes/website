import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditAction, Database, Json } from "@ac/shared";
import { hasServiceRole } from "../config";
import { adminClient } from "./supabase";

export interface AuditEntry {
  /** Who did it. Null when nobody is signed in: a witness acting through the
   *  emailed verification link. */
  actorId: string | null;
  action: AuditAction;
  targetType: "user" | "audition" | "testimony";
  targetId: string;
  /**
   * Context for the reader of the log. Keep witnesses OUT of it — no name, no
   * email, no testimony text: an entry is permanent, and must not outlive a
   * testimony its author withdrew. The audition's title and the testimony's id
   * are enough to say what was touched.
   */
  metadata?: { [key: string]: Json | undefined };
}

/** The longest text an entry keeps for one metadata value: the API's own
 *  limit for a title or a place. */
export const AUDIT_TEXT_MAX = 300;

/**
 * The metadata as it is stored: every text in it holds at most AUDIT_TEXT_MAX
 * characters, a longer one being cut and ended with "…". A title, a place or
 * a name read back from the database may be longer than the API accepts (a
 * row written past it), and the database refuses an entry over 16 kB: the
 * entry is shortened rather than lost.
 */
export function boundedMetadata(value: Json | undefined): Json | undefined {
  if (typeof value === "string") {
    if (value.length <= AUDIT_TEXT_MAX) return value;
    // Never half of a surrogate pair: the database refuses a lone one.
    const last = value.charCodeAt(AUDIT_TEXT_MAX - 2);
    const end = last >= 0xd800 && last <= 0xdbff ? AUDIT_TEXT_MAX - 2 : AUDIT_TEXT_MAX - 1;
    return `${value.slice(0, end)}…`;
  }
  if (Array.isArray(value)) return value.map((item) => boundedMetadata(item) ?? null);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, boundedMetadata(item)]),
    );
  }
  return value;
}

/**
 * Append one entry to the audit log.
 *
 * Call it AFTER the action has succeeded, so the log never claims something
 * that did not happen. It never throws and never fails the request: an action
 * that went through must not be reported to the user as failed because its log
 * line could not be written. A failure is logged server-side instead.
 *
 * The entry is written with the service role whenever its key is configured,
 * whichever client the caller holds: the database takes any entry from the
 * server, and from a signed-in account only the two lines the admin pages
 * write from the browser. Without the key (a developer's setup) the caller's
 * client is used, and the database refuses most entries: the failure is
 * logged, as any other.
 *
 * Long texts of the metadata are cut first (boundedMetadata).
 */
export async function logAudit(
  client: SupabaseClient<Database>,
  log: FastifyBaseLogger,
  entry: AuditEntry,
): Promise<void> {
  const writer = hasServiceRole ? adminClient : client;
  try {
    const { error } = await writer.rpc("insert_audit_log", {
      // The column is nullable; the generated type does not say so.
      p_user_id: entry.actorId as string,
      p_action: entry.action,
      p_target_type: entry.targetType,
      p_target_id: entry.targetId,
      p_metadata: boundedMetadata(entry.metadata) ?? {},
    });
    if (error) log.warn({ err: error, action: entry.action }, "audit log write failed");
  } catch (err) {
    log.warn({ err, action: entry.action }, "audit log write failed");
  }
}
