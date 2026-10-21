import type { FastifyInstance } from "fastify";
import { createTestimonySchema, updateTestimonySchema } from "@ac/shared";
import { cachedResponse } from "../../lib/cache";
import { sendCached } from "../../lib/httpCache";
import { PUBLIC_CACHE_KEYS, PUBLIC_CACHE_TTL_MS } from "../../lib/publicCache";
import { requireAdmin, requireSuperAdmin } from "../../lib/auth";
import { AnalysisDisabledError, AnalysisError } from "./analysis";
import {
  analyzeTestimony,
  createTestimony,
  deleteTestimony,
  fetchFilterableTestimonies,
  fetchPublicTestimonies,
  fetchTestimoniesForAudition,
  updateTestimony,
} from "./service";

// What an admin is told when trying to edit a testimony its witness verified.
const VERIFIED_LOCKED =
  "Ce témoignage a été vérifié par son auteur : il ne peut plus être modifié.";

export default async function testimonyRoutes(app: FastifyInstance) {
  // Public list of testimonies (RLS as anon) with audition context, newest
  // first. Powers the Témoignages page list + filters.
  app.get("/", async (req, reply) => {
    // Cached: this whole corpus is identical for every visitor and changes only
    // on admin writes (which invalidate the cache), so we pull it from Supabase
    // at most once per TTL instead of once per page view + window focus — and
    // its 4.75 MB of JSON are serialised and gzipped once per fill, not once
    // per request. `no-cache`: a returning visitor asks whether it changed and
    // is told so in a 304 instead of downloading 1.5 MB again, while an admin's
    // write still shows at the next load.
    try {
      const res = await cachedResponse(
        PUBLIC_CACHE_KEYS.testimonies,
        PUBLIC_CACHE_TTL_MS.testimonies,
        fetchPublicTestimonies,
      );
      return sendCached(req, reply, res, "no-cache");
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });

  // ---- Admin (RLS-scoped to the caller) ----

  // What the admin list's filters judge, for every testimony the caller can
  // see. Fetched once, when the filters are first opened.
  app.get("/admin/filterable", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const result = await fetchFilterableTestimonies(req.supabase);
    if (result.kind === "fetchFailed") return reply.internalServerError(result.message);
    return result.testimonies;
  });

  // All testimonies of one audition, oldest first (admin management view).
  app.get<{ Params: { auditionId: string } }>(
    "/for-audition/:auditionId",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const result = await fetchTestimoniesForAudition(req.supabase, req.params.auditionId);
      if (result.kind === "fetchFailed") return reply.internalServerError(result.message);
      return result.testimonies;
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
    const result = await createTestimony(req.supabase, req.log, req.user.id, parsed.data);
    if (result.kind === "onlineNeedsEmail") {
      return reply.badRequest(
        "Un email est requis pour un témoignage d'audition en ligne : il n'est publié qu'une fois validé par email.",
      );
    }
    if (result.kind === "dbError") return reply.badRequest(result.message);
    const { testimony, emailSent, emailError } = result;
    return reply.code(201).send({ testimony, emailSent, emailError });
  });

  // Update a testimony: back to pending (fresh token, new email) when a
  // displayed field changes; refused once its witness verified it.
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const parsed = updateTestimonySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
      }
      const result = await updateTestimony(
        req.supabase,
        req.log,
        req.user.id,
        req.params.id,
        parsed.data,
      );
      if (result.kind === "fetchFailed") return reply.internalServerError(result.message);
      if (result.kind === "notFound")
        return reply.notFound("Témoignage introuvable ou accès refusé");
      if (result.kind === "locked") return reply.conflict(VERIFIED_LOCKED);
      if (result.kind === "dbError") return reply.badRequest(result.message);
      const { testimony, reverificationSent, needsReverification } = result;
      return { testimony, reverificationSent, needsReverification };
    },
  );

  // Delete a testimony; says whether its audition went with it.
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const result = await deleteTestimony(req.supabase, req.log, req.user.id, req.params.id);
      if (result.kind === "dbError") return reply.badRequest(result.message);
      return { auditionDeleted: result.auditionDeleted };
    },
  );

  // AI thematic analysis of one testimony (super admin only — the old UI
  // gated this to super admins; the server now enforces it too).
  app.post<{ Params: { id: string } }>(
    "/:id/analyze",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireSuperAdmin(req, reply))) return reply;
      try {
        const result = await analyzeTestimony(req.supabase, req.params.id);
        if (result.kind === "fetchFailed") return reply.internalServerError(result.message);
        if (result.kind === "notFound") return reply.notFound("Témoignage introuvable");
        if (result.kind === "updateFailed") return reply.internalServerError(result.message);
        return { topics: result.topics };
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
