import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sanitizeText, type TablesUpdate } from "@ac/shared";
import { adminClient, publicClient } from "../supabase";
import { hasServiceRole } from "../config";

// Public testimony verification by emailed token. No authentication — the
// token IS the credential. Sends no emails.
//
// Client choice: before the policy-tightening migration the anon by-token RLS
// policies make publicClient work; after cutover those policies are gone and
// the service-role client (present in production) takes over.
function verifyClient() {
  return hasServiceRole ? adminClient : publicClient;
}

const EXPIRY_DAYS = 14;

// Reject malformed tokens before they reach Postgres (a non-UUID compared to
// the uuid column would surface as a raw 500).
const tokenSchema = z.string().uuid();

const actionSchema = z.object({
  action: z.enum(["verify", "reject"]),
  edits: z
    .object({
      person_name: z
        .string()
        .trim()
        .min(1, "Le nom est requis")
        .max(200, "Le nom est trop long"),
      person_info: z.string().trim().max(500, "Les informations sont trop longues").nullable(),
      content: z.string().trim().min(1, "Le témoignage est requis"),
    })
    .optional(),
});

function isExpired(createdAt: string | null): boolean {
  if (!createdAt) return false;
  const days = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return days > EXPIRY_DAYS;
}

async function fetchByToken(token: string) {
  return verifyClient()
    .from("testimonies")
    .select(
      "id, person_name, person_info, content, verification_status, created_at, audition:auditions(title, location, date)",
    )
    .eq("verification_token", token)
    .maybeSingle();
}

export default async function verifyRoutes(app: FastifyInstance) {
  // Look up the testimony behind a verification token.
  app.get<{ Params: { token: string } }>("/:token", async (req, reply) => {
    if (!tokenSchema.safeParse(req.params.token).success) {
      return reply.notFound("Témoignage introuvable ou déjà traité");
    }
    const { data, error } = await fetchByToken(req.params.token);
    if (error) return reply.internalServerError(error.message);
    if (!data) return reply.notFound("Témoignage introuvable ou déjà traité");

    if (data.verification_status === "pending" && isExpired(data.created_at)) {
      return reply.code(410).send({
        error:
          "Ce lien de vérification a expiré. Le délai de 14 jours pour valider votre témoignage est dépassé.",
      });
    }

    return data;
  });

  // Apply the citizen's decision: verify (with optional edits) or reject.
  app.post<{ Params: { token: string } }>("/:token", async (req, reply) => {
    if (!tokenSchema.safeParse(req.params.token).success) {
      return reply.notFound("Témoignage introuvable ou déjà traité");
    }
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
    }
    const { action, edits } = parsed.data;
    const token = req.params.token;

    const { data: existing, error: fetchError } = await fetchByToken(token);
    if (fetchError) return reply.internalServerError(fetchError.message);
    if (!existing) return reply.notFound("Témoignage introuvable ou déjà traité");
    if (existing.verification_status !== "pending") {
      return reply.code(409).send({
        error: `Ce témoignage a déjà été ${existing.verification_status === "verified" ? "validé" : "traité"}.`,
      });
    }
    if (isExpired(existing.created_at)) {
      return reply.code(410).send({
        error:
          "Ce lien de vérification a expiré. Le délai de 14 jours pour valider votre témoignage est dépassé.",
      });
    }

    if (action === "reject") {
      const { data: deleted, error } = await verifyClient()
        .from("testimonies")
        .delete()
        .eq("verification_token", token)
        .eq("verification_status", "pending")
        .select("id");
      if (error) return reply.internalServerError(error.message);
      // 0 rows: a concurrent request processed the testimony first.
      if (!deleted || deleted.length === 0) {
        return reply.code(409).send({ error: "Ce témoignage a déjà été traité." });
      }
      return { status: "rejected" };
    }

    // Verify, applying any staged edits (sanitized server-side like the old app).
    const payload: TablesUpdate<"testimonies"> = { verification_status: "verified" };
    if (edits) {
      payload.person_name = sanitizeText(edits.person_name);
      payload.person_info = edits.person_info ? sanitizeText(edits.person_info) : null;
      payload.content = sanitizeText(edits.content);
    }

    const { data: updated, error } = await verifyClient()
      .from("testimonies")
      .update(payload)
      .eq("verification_token", token)
      .eq("verification_status", "pending")
      .select("id");
    if (error) return reply.internalServerError(error.message);
    if (!updated || updated.length === 0) {
      return reply.code(409).send({ error: "Ce témoignage a déjà été traité." });
    }
    return { status: "verified", edited: Boolean(edits) };
  });
}
