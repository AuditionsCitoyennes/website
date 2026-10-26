import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  sanitizeText,
  type AdminTestimony,
  type createTestimonySchema,
  type Database,
  type UpdateTestimonyInput,
} from "@ac/shared";
import { publicClient } from "../../lib/supabase";
import { PAGE, selectAll } from "../../lib/paging";
import { invalidatePublicCaches } from "../../lib/publicCache";
import { logAudit } from "../../lib/audit";
import { frDate } from "../../lib/dates";
import { EmailsDisabledError } from "../../lib/email/resend";
import { sendVerificationEmails } from "../../lib/email/verification";
import { auditionGone } from "../auditions/service";
import { analyzeContent } from "./analysis";

type Client = SupabaseClient<Database>;
type CreateTestimonyInput = z.infer<typeof createTestimonySchema>;

/** A write the database refused: its message, for the route to send back. */
export interface DbError {
  kind: "dbError";
  message: string;
}

/** A read that failed before anything was decided. */
export interface FetchFailed {
  kind: "fetchFailed";
  message: string;
}

// What a signed-in caller may read from testimonies: every column but the
// email and the verification token, which the API no longer exposes (admins
// get the email through the admin_testimonies() function).
const READABLE_COLUMNS =
  "id, audition_id, person_name, person_info, content, topics, verification_status, created_by, created_at";

// ---- Reads ----------------------------------------------------------------

/**
 * The public corpus (RLS as anon) with audition context, newest first.
 * Paginated past PostgREST's 1000-row cap so older testimonies aren't
 * silently dropped.
 */
export async function fetchPublicTestimonies(): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await publicClient
      .from("testimonies")
      .select(
        "id, person_name, person_info, content, topics, verification_status, created_at, audition:auditions(id, title, location, date)",
      )
      // Secondary sort on id: created_at ties (batch inserts) would
      // otherwise make page windows skip/duplicate rows.
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

/**
 * Every testimony the caller can see, cut down to what the admin list's
 * filters judge (themes, verified, free text) and the audition it belongs
 * to — never the emails or the verification tokens.
 */
export async function fetchFilterableTestimonies(
  client: Client,
): Promise<{ kind: "ok"; testimonies: unknown[] } | FetchFailed> {
  const all: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("testimonies")
      .select("audition_id, person_name, person_info, content, topics, verification_status")
      // Stable pages: created_at ties (batch inserts) broken by id.
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { kind: "fetchFailed", message: error.message };
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return { kind: "ok", testimonies: all };
}

/**
 * All testimonies of one audition, oldest first (admin management view). The
 * function's own order, restated so that its pages hold still: one audition
 * may hold more than a page.
 */
export async function fetchTestimoniesForAudition(
  client: Client,
  auditionId: string,
): Promise<{ kind: "ok"; testimonies: AdminTestimony[] } | FetchFailed> {
  const { data, error } = await selectAll((from, to) =>
    client
      .rpc("admin_testimonies", { p_audition_id: auditionId })
      .order("created_at")
      .order("id")
      .range(from, to),
  );
  if (error) return { kind: "fetchFailed", message: error.message };
  return { kind: "ok", testimonies: data };
}

// ---- Create ---------------------------------------------------------------

export interface NewTestimony {
  id: string;
  audition_id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  email: string | null;
  topics: string[] | null;
  created_by: string;
  verification_status: string | null;
  verification_token: string | null;
}

export type CreateTestimonyResult =
  | { kind: "ok"; testimony: NewTestimony; emailSent: boolean; emailError: string | null }
  | { kind: "onlineNeedsEmail" }
  | DbError;

/**
 * Add a testimony to an audition; sends a verification email when an email
 * address is provided.
 */
export async function createTestimony(
  client: Client,
  log: FastifyBaseLogger,
  actorId: string,
  input: CreateTestimonyInput,
): Promise<CreateTestimonyResult> {
  const email = input.email || null;
  const verificationToken = email ? randomUUID() : null;

  // The audition, read once: the online rule below, then the verification
  // email's context and the audit entry (best effort for those two).
  // An online audition's testimonies are public only once validated by
  // email: without one, it would never be shown.
  const { data: audition } = await client
    .from("auditions")
    .select("audition_en_ligne, title, location, date")
    .eq("id", input.audition_id)
    .maybeSingle();
  if (audition?.audition_en_ligne && !email) return { kind: "onlineNeedsEmail" };

  const testimony: NewTestimony = {
    id: randomUUID(),
    audition_id: input.audition_id,
    person_name: sanitizeText(input.person_name),
    person_info: input.person_info ? sanitizeText(input.person_info) : null,
    content: sanitizeText(input.content),
    email,
    topics: input.topics && input.topics.length > 0 ? input.topics.map(sanitizeText) : null,
    created_by: actorId,
    verification_status: email ? "pending" : null,
    // Explicit NULL when no email — the column default (gen_random_uuid)
    // would otherwise make the row publicly updatable via the legacy
    // by-token RLS policies.
    verification_token: verificationToken,
  };

  const { error } = await client.from("testimonies").insert(testimony);
  if (error) return { kind: "dbError", message: error.message };
  invalidatePublicCaches();

  // Best-effort verification email — the testimony is kept even if it fails.
  let emailSent = false;
  let emailError: string | null = null;
  if (email && verificationToken) {
    try {
      const report = await sendVerificationEmails(
        [{ email, personName: testimony.person_name, verificationToken }],
        audition?.location ?? "",
        audition ? frDate(audition.date) : "",
      );
      emailSent = report.success;
      if (!report.success) emailError = report.results[0]?.error ?? "Envoi échoué";
    } catch (e) {
      emailError =
        e instanceof EmailsDisabledError
          ? e.message
          : "L'email de vérification n'a pas pu être envoyé";
    }
  }

  await logAudit(client, log, {
    actorId,
    action: "testimony_created",
    targetType: "testimony",
    targetId: testimony.id,
    metadata: {
      audition_id: input.audition_id,
      audition_title: audition?.title,
      // Whether the witness was asked to confirm, and whether the email left.
      verification: email ? (emailSent ? "sent" : "failed") : "none",
    },
  });

  return { kind: "ok", testimony, emailSent, emailError };
}

// ---- Update ---------------------------------------------------------------

export type UpdateTestimonyResult =
  | {
      kind: "ok";
      testimony: AdminTestimony;
      reverificationSent: boolean;
      needsReverification: boolean;
    }
  | { kind: "notFound" }
  /** Its witness verified it: nobody — super admins included — may change it. */
  | { kind: "locked" }
  | FetchFailed
  | DbError;

/**
 * Update a testimony. If the email is set and any displayed field changed,
 * the testimony goes back to pending with a fresh token + new email.
 *
 * Not once its witness has VERIFIED it: from then on the name, the
 * information, the email and the text are the witness's own validated words,
 * and nobody — super admins included — may change them. (Themes are not the
 * witness's words: the analysis may still tag a verified testimony.)
 */
export async function updateTestimony(
  client: Client,
  log: FastifyBaseLogger,
  actorId: string,
  id: string,
  input: UpdateTestimonyInput,
): Promise<UpdateTestimonyResult> {
  const { data: existing, error: fetchError } = await client
    .rpc("admin_testimonies", { p_id: id })
    .maybeSingle();
  if (fetchError) return { kind: "fetchFailed", message: fetchError.message };
  if (!existing) return { kind: "notFound" };
  const { data: audition } = existing.audition_id
    ? await client
        .from("auditions")
        .select("title, location, date")
        .eq("id", existing.audition_id)
        .maybeSingle()
    : { data: null };

  const next = {
    person_name:
      input.person_name !== undefined ? sanitizeText(input.person_name) : existing.person_name,
    person_info:
      input.person_info !== undefined
        ? input.person_info
          ? sanitizeText(input.person_info)
          : null
        : existing.person_info,
    content: input.content !== undefined ? sanitizeText(input.content) : existing.content,
    email: input.email !== undefined ? input.email || null : existing.email,
    topics:
      input.topics !== undefined
        ? input.topics && input.topics.length > 0
          ? input.topics.map(sanitizeText)
          : null
        : existing.topics,
  };

  const changed =
    next.email !== existing.email ||
    next.content !== existing.content ||
    next.person_name !== existing.person_name ||
    (next.person_info ?? "") !== (existing.person_info ?? "");
  if (changed && existing.verification_status === "verified") return { kind: "locked" };
  const needsReverification = Boolean(next.email) && changed;
  const newToken = needsReverification ? randomUUID() : null;

  // The witness's fields are written only when they really change — and
  // then under the lock again, in the statement itself: the witness may
  // verify (and correct the text) between the read above and this write.
  // Otherwise the themes alone: a statement without that condition must
  // never put a name or a text read a moment ago back on the row.
  let update = client
    .from("testimonies")
    .update(
      changed
        ? {
            ...next,
            ...(needsReverification
              ? { verification_status: "pending", verification_token: newToken }
              : {}),
          }
        : { topics: next.topics },
    )
    .eq("id", id);
  if (changed) {
    // (`neq` alone would also skip the rows that have no status at all.)
    update = update.or("verification_status.is.null,verification_status.neq.verified");
  }
  const { data: updated, error } = await update.select(READABLE_COLUMNS).maybeSingle();
  if (error) return { kind: "dbError", message: error.message };
  if (!updated) {
    // Nothing written: verified in the meantime, or not the caller's to edit.
    const { data: now } = await client
      .from("testimonies")
      .select("verification_status")
      .eq("id", id)
      .maybeSingle();
    return now?.verification_status === "verified" ? { kind: "locked" } : { kind: "notFound" };
  }
  invalidatePublicCaches();
  // Field NAMES only — never the values (see AuditEntry.metadata). Nothing
  // is logged for a save that changed nothing.
  const sameTopics = JSON.stringify(next.topics ?? []) === JSON.stringify(existing.topics ?? []);
  const fields = [
    ...(next.person_name !== existing.person_name ? ["person_name"] : []),
    ...((next.person_info ?? "") !== (existing.person_info ?? "") ? ["person_info"] : []),
    ...(next.content !== existing.content ? ["content"] : []),
    ...(next.email !== existing.email ? ["email"] : []),
    ...(sameTopics ? [] : ["topics"]),
  ];

  let emailSent = false;
  if (needsReverification && next.email && newToken) {
    try {
      const report = await sendVerificationEmails(
        [{ email: next.email, personName: next.person_name, verificationToken: newToken }],
        audition?.location ?? "",
        audition ? frDate(audition.date) : "",
      );
      emailSent = report.success;
    } catch {
      emailSent = false;
    }
  }

  // After the email, so the entry can say whether it left.
  if (fields.length > 0) {
    await logAudit(client, log, {
      actorId,
      action: "testimony_updated",
      targetType: "testimony",
      targetId: id,
      metadata: {
        audition_id: existing.audition_id,
        audition_title: audition?.title,
        fields,
        // Only when the witness has to confirm again.
        ...(needsReverification ? { verification: emailSent ? "sent" : "failed" } : {}),
      },
    });
  }

  return {
    kind: "ok",
    // The row as written; the email is the one just saved (not readable back).
    testimony: { ...updated, email: next.email },
    reverificationSent: emailSent,
    needsReverification,
  };
}

// ---- Delete ---------------------------------------------------------------

/** Delete a testimony; says whether its audition went with it. */
export async function deleteTestimony(
  client: Client,
  log: FastifyBaseLogger,
  actorId: string,
  id: string,
): Promise<{ kind: "ok"; auditionDeleted: boolean } | DbError> {
  // For the audit entries only: which audition it belonged to (best effort).
  const { data: before } = await client
    .from("testimonies")
    .select("id, audition_id, audition:auditions(title, date, location)")
    .eq("id", id)
    .maybeSingle();

  const { error, count } = await client.from("testimonies").delete({ count: "exact" }).eq("id", id);
  if (error) return { kind: "dbError", message: error.message };
  invalidatePublicCaches();
  // Not for an id that matched nothing: the log only says what happened.
  let auditionDeleted = false;
  if (count !== 0) {
    const audition = (before?.audition ?? null) as {
      title: string;
      date: string;
      location: string;
    } | null;
    await logAudit(client, log, {
      actorId,
      action: "testimony_deleted",
      targetType: "testimony",
      targetId: id,
      metadata: { audition_id: before?.audition_id, audition_title: audition?.title },
    });
    // Its last testimony, the audition went with it (the database never
    // leaves one empty): said to the page, which drops it from its list,
    // and logged.
    if (audition && before?.audition_id) {
      auditionDeleted = await auditionGone(client, before.audition_id);
      if (auditionDeleted) {
        await logAudit(client, log, {
          actorId,
          action: "audition_deleted",
          targetType: "audition",
          targetId: before.audition_id,
          metadata: {
            title: audition.title,
            date: audition.date,
            location: audition.location,
            emptied: true,
          },
        });
      }
    }
  }
  return { kind: "ok", auditionDeleted };
}

// ---- Analysis -------------------------------------------------------------

export type AnalyzeTestimonyResult =
  | { kind: "ok"; topics: string[] }
  | { kind: "notFound" }
  | FetchFailed
  /** The themes were found but could not be written. */
  | { kind: "updateFailed"; message: string };

/**
 * AI thematic analysis of one testimony, its themes written back. The
 * analysis's own failures (no key, rate limit, upstream error) are thrown
 * as analysis.ts's typed errors for the route to map.
 */
export async function analyzeTestimony(
  client: Client,
  id: string,
): Promise<AnalyzeTestimonyResult> {
  const { data: testimony, error: fetchError } = await client
    .from("testimonies")
    .select("id, content")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) return { kind: "fetchFailed", message: fetchError.message };
  if (!testimony) return { kind: "notFound" };

  const topics = await analyzeContent(testimony.content);
  if (topics.length > 0) {
    const { error } = await client.from("testimonies").update({ topics }).eq("id", testimony.id);
    if (error) return { kind: "updateFailed", message: error.message };
    invalidatePublicCaches();
  }
  return { kind: "ok", topics };
}
