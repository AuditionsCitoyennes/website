import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createTestimonySchema, sanitizeText, updateTestimonySchema } from "@ac/shared";
import { publicClient } from "../supabase";
import { cached, invalidatePublicCaches, PUBLIC_CACHE_KEYS } from "../cache";
import { requireAdmin, requireSuperAdmin } from "../auth";
import { EmailsDisabledError, frDate, sendVerificationEmails } from "../services/emails";
import { analyzeContent, AnalysisDisabledError, AnalysisError } from "../services/analysis";

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

    // Best-effort verification email — the testimony is kept even if it fails.
    let emailSent = false;
    let emailError: string | null = null;
    if (email && verificationToken) {
      const { data: audition } = await req.supabase
        .from("auditions")
        .select("location, date")
        .eq("id", input.audition_id)
        .maybeSingle();
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

    return reply.code(201).send({ testimony, emailSent, emailError });
  });

  // Update a testimony. If the email is set and any displayed field changed,
  // the testimony goes back to pending with a fresh token + new email.
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
        .select("*, audition:auditions(location, date)")
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
      const needsReverification = Boolean(next.email) && changed;
      const newToken = needsReverification ? randomUUID() : null;

      const { data: updated, error } = await req.supabase
        .from("testimonies")
        .update({
          ...next,
          ...(needsReverification
            ? { verification_status: "pending", verification_token: newToken }
            : {}),
        })
        .eq("id", req.params.id)
        .select()
        .maybeSingle();
      if (error) return reply.badRequest(error.message);
      if (!updated) return reply.notFound("Témoignage introuvable ou accès refusé");
      invalidatePublicCaches();

      let emailSent = false;
      if (needsReverification && next.email && newToken) {
        const audition = existing.audition as { location: string; date: string } | null;
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

      return { testimony: updated, reverificationSent: emailSent, needsReverification };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const { error } = await req.supabase.from("testimonies").delete().eq("id", req.params.id);
      if (error) return reply.badRequest(error.message);
      invalidatePublicCaches();
      return reply.code(204).send();
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
