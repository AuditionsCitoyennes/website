import type { FastifyInstance } from "fastify";
import { createAuditionSchema, updateAuditionSchema } from "@ac/shared";
import { publicClient } from "../../lib/supabase";
import { cachedResponse } from "../../lib/cache";
import { sendCached } from "../../lib/httpCache";
import { PUBLIC_CACHE_KEYS } from "../../lib/publicCache";
import { requireAdmin } from "../../lib/auth";
import {
  createAudition,
  deleteAudition,
  fetchAdminAuditions,
  fetchPublishedAudition,
  fetchPublishedAuditions,
  updateAudition,
} from "./service";

export default async function auditionRoutes(app: FastifyInstance) {
  // ---- Public reads (RLS as anon: published auditions + visible testimonies) ----

  // List published auditions with a count of their (visible) testimonies.
  app.get("/", async (req, reply) => {
    // Cached: same published list for every visitor, changes only on admin
    // writes (which invalidate it). Public API only: the website itself no
    // longer reads it (its analyses are built from /api/map + /api/testimonies).
    // `no-cache`: a client revalidates (304) rather than keep a copy past a write.
    try {
      const res = await cachedResponse(
        PUBLIC_CACHE_KEYS.auditions,
        60_000,
        fetchPublishedAuditions,
      );
      return sendCached(req, reply, res, "no-cache");
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });

  // ---- Admin (role-gated; queries RLS-scoped to the caller) ----

  // Admin management list, each audition with its `area` for the place filter.
  app.get("/admin/list", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const result = await fetchAdminAuditions(req.supabase);
    if (result.kind === "dbError") return reply.internalServerError(result.message);
    return result.auditions;
  });

  // One published audition with its visible testimonies (public detail page).
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const result = await fetchPublishedAudition(publicClient, req.params.id);
    if (result.kind === "dbError") return reply.internalServerError(result.message);
    if (result.kind === "notFound") return reply.notFound("Audition introuvable");
    return result.audition;
  });

  // Create an audition with optional inline testimonies; testimonies with an
  // email get a verification token and a batch verification email.
  app.post("/", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const parsed = createAuditionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
    }
    const result = await createAudition(req.supabase, req.log, req.user.id, parsed.data);
    if (result.kind === "dbError") return reply.badRequest(result.message);
    return reply.code(201).send({
      ...result.audition,
      testimonies: result.testimonies,
      emailReport: result.emailReport,
    });
  });

  // Update an audition (an online one keeps its town hall and month).
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const parsed = updateAuditionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
      }
      const result = await updateAudition(
        req.supabase,
        req.log,
        req.user.id,
        req.params.id,
        parsed.data,
      );
      if (result.kind === "dbError") return reply.badRequest(result.message);
      return { success: true };
    },
  );

  // Delete an audition and its testimonies.
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const result = await deleteAudition(req.supabase, req.log, req.user.id, req.params.id);
      if (result.kind === "dbError") return reply.badRequest(result.message);
      return reply.code(204).send();
    },
  );
}
