import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ONLINE_TESTIMONY_MAX, sanitizeText, type TablesUpdate } from "@ac/shared";
import { adminClient, publicClient } from "../../lib/supabase";
import { hasServiceRole } from "../../config";
import { logAudit } from "../../lib/audit";
import { auditionGone } from "../auditions/service";
import { invalidatePublicCaches } from "../../lib/publicCache";

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
      person_name: z.string().trim().min(1, "Le nom est requis").max(200, "Le nom est trop long"),
      person_info: z.string().trim().max(500, "Les informations sont trop longues").nullable(),
      // A ceiling for every testimony (anyone sending one from the site now
      // holds such a link); online ones get the form's own, tighter limits below.
      content: z
        .string()
        .trim()
        .min(1, "Le témoignage est requis")
        .max(20000, "Le témoignage est trop long"),
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
      "id, audition_id, person_name, person_info, content, verification_status, created_at, audition:auditions(title, location, date, audition_en_ligne)",
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

    // `audition_id` is read for the audit entry only: the page has no use for it.
    const testimony: Partial<typeof data> = { ...data };
    delete testimony.audition_id;
    return testimony;
  });

  // Apply the citizen's decision: verify (with optional edits) or reject.
  app.post<{ Params: { token: string } }>(
    "/:token",
    { bodyLimit: 64 * 1024 },
    async (req, reply) => {
      if (!tokenSchema.safeParse(req.params.token).success) {
        return reply.notFound("Témoignage introuvable ou déjà traité");
      }
      const parsed = actionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
      }
      const { action, edits } = parsed.data;
      const token = req.params.token;

      // The witness's decision goes in the audit log with NO actor (nobody is
      // signed in) and no personal data: the audition's title says which one.
      const logDecision = (
        action: "testimony_verified" | "testimony_rejected",
        testimony: { id: string; audition_id: string | null },
        auditionTitle: string | undefined,
        extra: { edited?: boolean } = {},
      ) =>
        logAudit(verifyClient(), req.log, {
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

      // The embedded audition comes back as an object or a one-item array,
      // depending on how the relationship is typed.
      type Embedded = {
        title?: string;
        date?: string;
        location?: string;
        audition_en_ligne?: boolean;
      };
      const embedded = existing.audition as Embedded | Embedded[] | null;
      const audition = Array.isArray(embedded) ? embedded[0] : embedded;
      const auditionTitle = audition?.title;

      // Sent from the site's form: edited within that form's limits.
      if (edits && audition?.audition_en_ligne) {
        if (edits.person_name.length > 80) return reply.badRequest("Le nom est trop long");
        if ((edits.person_info ?? "").length > 300) {
          return reply.badRequest("Les informations sont trop longues");
        }
        if (edits.content.length > ONLINE_TESTIMONY_MAX) {
          return reply.badRequest(
            `Le témoignage est trop long (${ONLINE_TESTIMONY_MAX} caractères au plus)`,
          );
        }
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
        // The public site counted it (an audition's pending testimonies are
        // shown, an online one's are not): what it shows changed.
        invalidatePublicCaches();
        await logDecision("testimony_rejected", existing, auditionTitle);
        // Its audition's last testimony: the audition went with it (the
        // database never leaves one empty) — logged too, with no actor either.
        if (audition && existing.audition_id) {
          if (await auditionGone(verifyClient(), existing.audition_id)) {
            await logAudit(verifyClient(), req.log, {
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
      return { status: "verified", edited: Boolean(edits) };
    },
  );
}
