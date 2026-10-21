import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditAction, Database, Json } from "@ac/shared";

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

/**
 * Append one entry to the audit log.
 *
 * Call it AFTER the action has succeeded, so the log never claims something
 * that did not happen. It never throws and never fails the request: an action
 * that went through must not be reported to the user as failed because its log
 * line could not be written. A failure is logged server-side instead.
 */
export async function logAudit(
  client: SupabaseClient<Database>,
  log: FastifyBaseLogger,
  entry: AuditEntry,
): Promise<void> {
  try {
    const { error } = await client.rpc("insert_audit_log", {
      // The column is nullable; the generated type does not say so.
      p_user_id: entry.actorId as string,
      p_action: entry.action,
      p_target_type: entry.targetType,
      p_target_id: entry.targetId,
      p_metadata: entry.metadata ?? {},
    });
    if (error) log.warn({ err: error, action: entry.action }, "audit log write failed");
  } catch (err) {
    log.warn({ err, action: entry.action }, "audit log write failed");
  }
}
