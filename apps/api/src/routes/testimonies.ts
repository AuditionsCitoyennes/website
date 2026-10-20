import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createTestimonySchema, sanitizeText, updateTestimonySchema } from "@ac/shared";
import { publicClient } from "../lib/supabase";
import { cached } from "../lib/cache";
import { invalidatePublicCaches, PUBLIC_CACHE_KEYS } from "../lib/publicCache";
import { requireAdmin, requireSuperAdmin } from "../lib/auth";
import { frDate } from "../lib/dates";
import { EmailsDisabledError } from "../lib/email/resend";
import { sendVerificationEmails } from "../lib/email/verification";
import { analyzeContent, AnalysisDisabledError, AnalysisError } from "../services/analysis";
import { logAudit } from "../lib/audit";
import { auditionGone } from "../services/auditions";

// What an admin is told when trying to edit a testimony its witness verified.
const VERIFIED_LOCKED =
  "Ce témoignage a été vérifié par son auteur : il ne peut plus être modifié.";

export default async function testimonyRoutes(app: FastifyInstance) {
  // Public list of testimonies (RLS as anon) with audition context, newest
  // first. Powers the Témoignages page list + filters. Paginated past
  // PostgREST's 1000-row cap so older testimonies aren't silently dropped.
  app.get("/", async (_req, reply) => {
    // Cached: this whole corpus is identical for every visitor and changes only
    // on admin writes (which invalidate the cache), so we pull it from Supabase
    // at most once per TTL instead of once per page view + window focus.
    try {
      return await cached(PUBLIC_CACHE_KEYS.testimonies, 60_000, async () => {
        const PAGE = 1000;
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
      });
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });

  // ---- Admin (RLS-scoped to the caller) ----

  // Every testimony the caller can see, cut down to what the admin list's
  // filters judge (themes, verified, free text) and the audition it belongs
  // to. Fetched once, when the filters are first opened — never the emails or
  // the verification tokens.
  app.get("/admin/filterable", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const PAGE = 1000; // PostgREST's cap: past it a bare select is silently cut short
    const all: unknown[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await req.supabase
        .from("testimonies")
        .select("audition_id, person_name, person_info, content, topics, verification_status")
        // Stable pages: created_at ties (batch inserts) broken by id.
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return reply.internalServerError(error.message);
      all.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    return all;
  });

  // All testimonies of one audition, oldest first (admin management view).
  app.get<{ Params: { auditionId: string } }>(
    "/for-audition/:auditionId",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const { data, error } = await req.supabase
        .from("testimonies")
        .select("*")
        .eq("audition_id", req.params.auditionId)
        .order("created_at", { ascending: true });
      if (error) return reply.internalServerError(error.message);
      return data ?? [];
    },
  );

  // Add a testimony to an audition; sends a verification email when an
  // email address is provided.
  app.post("/", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const parsed = createTestimonySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
    }
    const input = parsed.data;
    const email = input.email || null;
    const verificationToken = email ? randomUUID() : null;

    // An online audition's testimonies are public only once validated by
    // email: without one, it would never be shown.
    const { data: target } = await req.supabase
      .from("auditions")
      .select("audition_en_ligne")
      .eq("id", input.audition_id)
      .maybeSingle();
    if (target?.audition_en_ligne && !email) {
      return reply.badRequest(
        "Un email est requis pour un témoignage d'audition en ligne : il n'est publié qu'une fois validé par email.",
      );
    }

    const testimony = {
      id: randomUUID(),
      audition_id: input.audition_id,
      person_name: sanitizeText(input.person_name),
      person_info: input.person_info ? sanitizeText(input.person_info) : null,
      content: sanitizeText(input.content),
      email,
      topics: input.topics && input.topics.length > 0 ? input.topics.map(sanitizeText) : null,
      created_by: req.user.id,
      verification_status: email ? "pending" : null,
      // Explicit NULL when no email — the column default (gen_random_uuid)
      // would otherwise make the row publicly updatable via the legacy
      // by-token RLS policies.
      verification_token: verificationToken,
    };

    const { error } = await req.supabase.from("testimonies").insert(testimony);
    if (error) return reply.badRequest(error.message);
    invalidatePublicCaches();

    // The audition is context for the verification email and for the audit
    // entry — best effort for both.
    const { data: audition } = await req.supabase
      .from("auditions")
      .select("title, location, date")
      .eq("id", input.audition_id)
      .maybeSingle();

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

    await logAudit(req.supabase, req.log, {
      actorId: req.user.id,
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

    return reply.code(201).send({ testimony, emailSent, emailError });
  });

  // Update a testimony. If the email is set and any displayed field changed,
  // the testimony goes back to pending with a fresh token + new email.
  //
  // Not once its witness has VERIFIED it: from then on the name, the
  // information, the email and the text are the witness's own validated words,
  // and nobody — super admins included — may change them. (Themes are not the
  // witness's words: the analysis may still tag a verified testimony.)
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const parsed = updateTestimonySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
      }
      const input = parsed.data;

      const { data: existing, error: fetchError } = await req.supabase
        .from("testimonies")
        .select("*, audition:auditions(title, location, date)")
        .eq("id", req.params.id)
        .maybeSingle();
      if (fetchError) return reply.internalServerError(fetchError.message);
      if (!existing) return reply.notFound("Témoignage introuvable ou accès refusé");

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
      if (changed && existing.verification_status === "verified") {
        return reply.conflict(VERIFIED_LOCKED);
      }
      const needsReverification = Boolean(next.email) && changed;
      const newToken = needsReverification ? randomUUID() : null;

      // The witness's fields are written only when they really change — and
      // then under the lock again, in the statement itself: the witness may
      // verify (and correct the text) between the read above and this write.
      // Otherwise the themes alone: a statement without that condition must
      // never put a name or a text read a moment ago back on the row.
      let update = req.supabase
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
        .eq("id", req.params.id);
      if (changed) {
        // (`neq` alone would also skip the rows that have no status at all.)
        update = update.or("verification_status.is.null,verification_status.neq.verified");
      }
      const { data: updated, error } = await update.select().maybeSingle();
      if (error) return reply.badRequest(error.message);
      if (!updated) {
        // Nothing written: verified in the meantime, or not the caller's to edit.
        const { data: now } = await req.supabase
          .from("testimonies")
          .select("verification_status")
          .eq("id", req.params.id)
          .maybeSingle();
        return now?.verification_status === "verified"
          ? reply.conflict(VERIFIED_LOCKED)
          : reply.notFound("Témoignage introuvable ou accès refusé");
      }
      invalidatePublicCaches();

      const audition = existing.audition as {
        title: string;
        location: string;
        date: string;
      } | null;
      // Field NAMES only — never the values (see AuditEntry.metadata). Nothing
      // is logged for a save that changed nothing.
      const sameTopics =
        JSON.stringify(next.topics ?? []) === JSON.stringify(existing.topics ?? []);
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
        await logAudit(req.supabase, req.log, {
          actorId: req.user.id,
          action: "testimony_updated",
          targetType: "testimony",
          targetId: req.params.id,
          metadata: {
            audition_id: existing.audition_id,
            audition_title: audition?.title,
            fields,
            // Only when the witness has to confirm again.
            ...(needsReverification ? { verification: emailSent ? "sent" : "failed" } : {}),
          },
        });
      }

      return { testimony: updated, reverificationSent: emailSent, needsReverification };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      // For the audit entries only: which audition it belonged to (best effort).
      const { data: before } = await req.supabase
        .from("testimonies")
        .select("id, audition_id, audition:auditions(title, date, location)")
        .eq("id", req.params.id)
        .maybeSingle();

      const { error, count } = await req.supabase
        .from("testimonies")
        .delete({ count: "exact" })
        .eq("id", req.params.id);
      if (error) return reply.badRequest(error.message);
      invalidatePublicCaches();
      // Not for an id that matched nothing: the log only says what happened.
      let auditionDeleted = false;
      if (count !== 0) {
        const audition = (before?.audition ?? null) as {
          title: string;
          date: string;
          location: string;
        } | null;
        await logAudit(req.supabase, req.log, {
          actorId: req.user.id,
          action: "testimony_deleted",
          targetType: "testimony",
          targetId: req.params.id,
          metadata: { audition_id: before?.audition_id, audition_title: audition?.title },
        });
        // Its last testimony, the audition went with it (the database never
        // leaves one empty): said to the page, which drops it from its list,
        // and logged.
        if (audition && before?.audition_id) {
          auditionDeleted = await auditionGone(req.supabase, before.audition_id);
          if (auditionDeleted) {
            await logAudit(req.supabase, req.log, {
              actorId: req.user.id,
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
      return { auditionDeleted };
    },
  );

  // AI thematic analysis of one testimony (super admin only — the old UI
  // gated this to super admins; the server now enforces it too).
  app.post<{ Params: { id: string } }>(
    "/:id/analyze",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireSuperAdmin(req, reply))) return reply;

      const { data: testimony, error: fetchError } = await req.supabase
        .from("testimonies")
        .select("id, content")
        .eq("id", req.params.id)
        .maybeSingle();
      if (fetchError) return reply.internalServerError(fetchError.message);
      if (!testimony) return reply.notFound("Témoignage introuvable");

      try {
        const topics = await analyzeContent(testimony.content);
        if (topics.length > 0) {
          const { error } = await req.supabase
            .from("testimonies")
            .update({ topics })
            .eq("id", testimony.id);
          if (error) return reply.internalServerError(error.message);
          invalidatePublicCaches();
        }
        return { topics };
      } catch (e) {
        if (e instanceof AnalysisDisabledError) {
          return reply.code(503).send({ error: e.message });
        }
        if (e instanceof AnalysisError) {
          return reply.code(e.statusCode).send({ error: e.message });
        }
        return reply.internalServerError(e instanceof Error ? e.message : "Erreur inconnue");
      }
    },
  );
}
