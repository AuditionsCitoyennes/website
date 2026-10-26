import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createAuditionSchema, updateAuditionSchema } from "@ac/shared";
import { publicClient } from "../../lib/supabase";
import { cached, cachedResponse } from "../../lib/cache";
import { sendCached } from "../../lib/httpCache";
import { auditionCacheKey, PUBLIC_CACHE_KEYS, PUBLIC_CACHE_TTL_MS } from "../../lib/publicCache";
import { requireAdmin } from "../../lib/auth";
import { requestedSource } from "../map/locationGroups";
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
    const res = await cachedResponse(
      PUBLIC_CACHE_KEYS.auditions,
      PUBLIC_CACHE_TTL_MS.auditions,
      fetchPublishedAuditions,
    );
    return sendCached(req, reply, res, "no-cache");
  });

  // ---- Admin (role-gated; queries RLS-scoped to the caller) ----

  // Admin management list, each audition with its `area` for the place filter
  // (testing tools: ?source=geocoder, the geocoder's areas).
  app.get<{ Querystring: { source?: string } }>(
    "/admin/list",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const result = await fetchAdminAuditions(req.supabase, requestedSource(req.query));
      if (result.kind === "dbError") return reply.internalServerError(result.message);
      return result.auditions;
    },
  );

  // One published audition with its visible testimonies (public detail page).
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const { id } = req.params;
    // A non-UUID compared to the uuid column would surface as a raw 500.
    if (!z.string().uuid().safeParse(id).success) return reply.notFound("Audition introuvable");
    // Cached per id, dropped with the other public caches on any write: this
    // was the only public read that went to Supabase on every request. A
    // failed read is not kept.
    const result = await cached(auditionCacheKey(id), PUBLIC_CACHE_TTL_MS.auditions, async () => {
      const r = await fetchPublishedAudition(publicClient, id);
      if (r.kind === "dbError") throw new Error(r.message);
      return r;
    });
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
