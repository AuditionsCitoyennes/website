import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ONLINE_TESTIMONY_MAX, sanitizeText, type Database, type TablesUpdate } from "@ac/shared";
import { adminClient, publicClient } from "../../lib/supabase";
import { hasServiceRole } from "../../config";
import { logAudit } from "../../lib/audit";
import { auditionGone } from "../auditions/service";
import { invalidatePublicCaches } from "../../lib/publicCache";

// Public testimony verification by emailed token. No authentication — the
// token IS the credential. Sends no emails.

type Client = SupabaseClient<Database>;

/**
 * Client choice: before the policy-tightening migration the anon by-token
 * RLS policies make publicClient work; after cutover those policies are gone
 * and the service-role client (present in production) takes over.
 */
export function verifyClient(): Client {
  return hasServiceRole ? adminClient : publicClient;
}

export const EXPIRY_DAYS = 14;

function isExpired(createdAt: string | null): boolean {
  if (!createdAt) return false;
  const days = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return days > EXPIRY_DAYS;
}

async function fetchByToken(client: Client, token: string) {
  return client
    .from("testimonies")
    .select(
      "id, audition_id, person_name, person_info, content, verification_status, created_at, audition:auditions(title, location, date, audition_en_ligne)",
    )
    .eq("verification_token", token)
    .maybeSingle();
}

type TokenRow = NonNullable<Awaited<ReturnType<typeof fetchByToken>>["data"]>;

/** A read that failed, or a write the database refused: its message. */
export interface FetchFailed {
  kind: "fetchFailed";
  message: string;
}
export interface DbError {
  kind: "dbError";
  message: string;
}

// ---- Lookup ---------------------------------------------------------------

/** What the verification page shows: the testimony behind a token. */
export type TokenLookupResult =
  | { kind: "ok"; testimony: Partial<TokenRow> }
  | { kind: "notFound" }
  /** Pending past EXPIRY_DAYS. */
  | { kind: "expired" }
  | FetchFailed;

export async function fetchTestimonyByToken(
  client: Client,
  token: string,
): Promise<TokenLookupResult> {
  const { data, error } = await fetchByToken(client, token);
  if (error) return { kind: "fetchFailed", message: error.message };
  if (!data) return { kind: "notFound" };

  if (data.verification_status === "pending" && isExpired(data.created_at)) {
    return { kind: "expired" };
  }

  // `audition_id` is read for the audit entry only: the page has no use for it.
  const testimony: Partial<typeof data> = { ...data };
  delete testimony.audition_id;
  return { kind: "ok", testimony };
}

// ---- Decision -------------------------------------------------------------

/** The witness's corrections, within the limits the route already checked. */
export interface VerificationEdits {
  person_name: string;
  person_info: string | null;
  content: string;
}

export interface Decision {
  action: "verify" | "reject";
  edits?: VerificationEdits;
}

export type DecisionResult =
  | { kind: "rejected" }
  | { kind: "verified" }
  | { kind: "notFound" }
  /** Not pending any more: `status` says what it became. */
  | { kind: "alreadyProcessed"; status: string | null }
  | { kind: "expired" }
  /** Sent from the site's form: edited beyond that form's own limits. */
  | { kind: "editsTooLong"; field: "person_name" | "person_info" | "content" }
  /** A concurrent request processed the testimony first. */
  | { kind: "raced" }
  | FetchFailed
  | DbError;

// The embedded audition comes back as an object or a one-item array,
// depending on how the relationship is typed.
type Embedded = {
  title?: string;
  date?: string;
  location?: string;
  audition_en_ligne?: boolean;
};

/** Apply the citizen's decision: verify (with optional edits) or reject. */
export async function decideTestimony(
  client: Client,
  log: FastifyBaseLogger,
  token: string,
  { action, edits }: Decision,
): Promise<DecisionResult> {
  // The witness's decision goes in the audit log with NO actor (nobody is
  // signed in) and no personal data: the audition's title says which one.
  const logDecision = (
    action: "testimony_verified" | "testimony_rejected",
    testimony: { id: string; audition_id: string | null },
    auditionTitle: string | undefined,
    extra: { edited?: boolean } = {},
  ) =>
    logAudit(client, log, {
      actorId: null,
      action,
      targetType: "testimony",
      targetId: testimony.id,
      metadata: {
        audition_id: testimony.audition_id,
        audition_title: auditionTitle,
        ...extra,
      },
    });

  const { data: existing, error: fetchError } = await fetchByToken(client, token);
  if (fetchError) return { kind: "fetchFailed", message: fetchError.message };
  if (!existing) return { kind: "notFound" };
  if (existing.verification_status !== "pending") {
    return { kind: "alreadyProcessed", status: existing.verification_status };
  }
  if (isExpired(existing.created_at)) return { kind: "expired" };

  const embedded = existing.audition as Embedded | Embedded[] | null;
  const audition = Array.isArray(embedded) ? embedded[0] : embedded;
  const auditionTitle = audition?.title;

  // Sent from the site's form: edited within that form's limits.
  if (edits && audition?.audition_en_ligne) {
    if (edits.person_name.length > 80) return { kind: "editsTooLong", field: "person_name" };
    if ((edits.person_info ?? "").length > 300) {
      return { kind: "editsTooLong", field: "person_info" };
    }
    if (edits.content.length > ONLINE_TESTIMONY_MAX) {
      return { kind: "editsTooLong", field: "content" };
    }
  }

  if (action === "reject") {
    const { data: deleted, error } = await client
      .from("testimonies")
      .delete()
      .eq("verification_token", token)
      .eq("verification_status", "pending")
      .select("id");
    if (error) return { kind: "dbError", message: error.message };
    // 0 rows: a concurrent request processed the testimony first.
    if (!deleted || deleted.length === 0) return { kind: "raced" };
    // The public site counted it (an audition's pending testimonies are
    // shown, an online one's are not): what it shows changed.
    invalidatePublicCaches();
    await logDecision("testimony_rejected", existing, auditionTitle);
    // Its audition's last testimony: the audition went with it (the
    // database never leaves one empty) — logged too, with no actor either.
    if (audition && existing.audition_id) {
      if (await auditionGone(client, existing.audition_id)) {
        await logAudit(client, log, {
          actorId: null,
          action: "audition_deleted",
          targetType: "audition",
          targetId: existing.audition_id,
          metadata: {
            title: audition.title,
            date: audition.date,
            location: audition.location,
            emptied: true,
            by_witness: true,
          },
        });
      }
    }
    return { kind: "rejected" };
  }

  // Verify, applying any staged edits (sanitized server-side like the old app).
  const payload: TablesUpdate<"testimonies"> = { verification_status: "verified" };
  if (edits) {
    payload.person_name = sanitizeText(edits.person_name);
    payload.person_info = edits.person_info ? sanitizeText(edits.person_info) : null;
    payload.content = sanitizeText(edits.content);
  }

  const { data: updated, error } = await client
    .from("testimonies")
    .update(payload)
    .eq("verification_token", token)
    .eq("verification_status", "pending")
    .select("id");
  if (error) return { kind: "dbError", message: error.message };
  if (!updated || updated.length === 0) return { kind: "raced" };
  // Now verified — and, if it was sent from the site, now public: the public
  // reads must not wait out their cache for it.
  invalidatePublicCaches();
  // For the log, "edited" means the witness changed something — not merely
  // that the form was opened and saved as it was.
  const edited =
    Boolean(edits) &&
    (payload.person_name !== existing.person_name ||
      (payload.person_info ?? "") !== (existing.person_info ?? "") ||
      payload.content !== existing.content);
  await logDecision("testimony_verified", existing, auditionTitle, { edited });
  return { kind: "verified" };
}
