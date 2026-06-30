import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  createAuditionSchema,
  normalizeLocation,
  sanitizeText,
  updateAuditionSchema,
} from "@ac/shared";
import { publicClient } from "../supabase";
import { cached, invalidatePublicCaches, PUBLIC_CACHE_KEYS } from "../cache";
import { requireAdmin } from "../auth";
import { fetchPublishedAuditions } from "../services/locations";
import {
  frDate,
  sendVerificationEmails,
  type SendReport,
  type VerificationRecipient,
} from "../services/emails";

export default async function auditionRoutes(app: FastifyInstance) {
  // ---- Public reads (RLS as anon: published auditions + visible testimonies) ----

  // List published auditions with a count of their (visible) testimonies.
  app.get("/", async (_req, reply) => {
    // Cached: same published list for every visitor, changes only on admin
    // writes (which invalidate it). Powers the Analyses page on each mount.
    try {
      return await cached(PUBLIC_CACHE_KEYS.auditions, 60_000, fetchPublishedAuditions);
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });

  // ---- Admin (role-gated; queries RLS-scoped to the caller) ----

  // Admin management list: whatever the caller's RLS lets them see. NOTE:
  // drafts only appear once the audition SELECT policy migration is applied.
  app.get("/admin/list", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const { data, error } = await req.supabase
      .from("auditions")
      .select("id, title, date, location, content, status, created_by")
      .order("date", { ascending: false });
    if (error) return reply.internalServerError(error.message);
    return data ?? [];
  });

  // One published audition with its visible testimonies (public detail page).
  // Explicit testimony columns: RLS limits rows, not columns — `*` would leak
  // email addresses and verification tokens (the old app had this bug).
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const { data, error } = await publicClient
      .from("auditions")
      .select(
        "*, testimonies(id, person_name, person_info, content, topics, verification_status, created_at)",
      )
      .eq("id", req.params.id)
      .eq("status", "published")
      .maybeSingle();
    if (error) return reply.internalServerError(error.message);
    if (!data) return reply.notFound("Audition introuvable");
    return data;
  });

  // Create an audition with optional inline testimonies; testimonies with an
  // email get a verification token and a batch verification email.
  // The id is generated server-side so no RLS-filtered readback is needed
  // (drafts are not SELECT-visible until the policy migration is applied).
  app.post("/", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const parsed = createAuditionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
    }
    const { testimonies, ...input } = parsed.data;

    const auditionId = randomUUID();
    const audition = {
      id: auditionId,
      title: sanitizeText(input.title),
      date: input.date,
      location: normalizeLocation(input.location),
      content: sanitizeText(input.content),
      status: input.status,
      created_by: req.user.id,
    };

    const { error } = await req.supabase.from("auditions").insert(audition);
    if (error) return reply.badRequest(error.message);
    invalidatePublicCaches();

    let emailReport: SendReport | null = null;

    const valid = testimonies.filter((t) => t.person_name && t.content);
    const rows = valid.map((t) => {
      const email = t.email || null;
      return {
        id: randomUUID(),
        audition_id: auditionId,
        person_name: sanitizeText(t.person_name),
        person_info: t.person_info ? sanitizeText(t.person_info) : null,
        content: sanitizeText(t.content),
        email,
        topics: t.topics && t.topics.length > 0 ? t.topics.map(sanitizeText) : null,
        // No email -> NULL status (no badge) and NO token: the column default
        // (gen_random_uuid) would otherwise make the row publicly updatable
        // through the legacy by-token RLS policies.
        verification_status: email ? "pending" : null,
        verification_token: email ? randomUUID() : null,
        created_by: req.user.id,
      };
    });

    if (rows.length > 0) {
      const { error: terr } = await req.supabase.from("testimonies").insert(rows);
      if (terr) return reply.badRequest(terr.message);

      // Batch verification emails (best-effort: failures don't undo creation).
      const recipients: VerificationRecipient[] = rows
        .filter((r) => r.email && r.verification_token)
        .map((r) => ({
          email: r.email as string,
          personName: r.person_name,
          verificationToken: r.verification_token as string,
        }));

      if (recipients.length > 0) {
        try {
          emailReport = await sendVerificationEmails(
            recipients,
            audition.location,
            frDate(audition.date),
          );
        } catch (e) {
          req.log.warn({ err: e }, "verification emails failed");
          emailReport = { success: false, sent: 0, failed: recipients.length, results: [] };
        }
      }
    }

    return reply.code(201).send({ ...audition, testimonies: rows, emailReport });
  });

  // Update an audition. No RLS readback: a published->draft transition makes
  // the row invisible to SELECT until the policy migration is applied, which
  // would otherwise turn a successful update into a phantom 404.
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const parsed = updateAuditionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
      }
      const input = parsed.data;

      const { error } = await req.supabase
        .from("auditions")
        .update({
          ...(input.title !== undefined ? { title: sanitizeText(input.title) } : {}),
          ...(input.date !== undefined ? { date: input.date } : {}),
          ...(input.location !== undefined ? { location: normalizeLocation(input.location) } : {}),
          ...(input.content !== undefined ? { content: sanitizeText(input.content) } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        })
        .eq("id", req.params.id);
      if (error) return reply.badRequest(error.message);
      invalidatePublicCaches();
      return { success: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      // Delete linked testimonies first (the FK is ON DELETE SET NULL, which
      // would otherwise leave orphans) — same as the old app.
      const { error: terr } = await req.supabase
        .from("testimonies")
        .delete()
        .eq("audition_id", req.params.id);
      if (terr) return reply.badRequest(terr.message);

      const { error } = await req.supabase.from("auditions").delete().eq("id", req.params.id);
      if (error) return reply.badRequest(error.message);
      invalidatePublicCaches();
      return reply.code(204).send();
    },
  );
}
