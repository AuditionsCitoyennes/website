import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ONLINE_TESTIMONY_MAX } from "@ac/shared";
import { decideTestimony, fetchTestimonyByToken, verifyClient } from "./service";

// Public testimony verification by emailed token. No authentication — the
// token IS the credential. Sends no emails.

const NOT_FOUND = "Témoignage introuvable ou déjà traité";
const EXPIRED =
  "Ce lien de vérification a expiré. Le délai de 14 jours pour valider votre témoignage est dépassé.";
const ALREADY_PROCESSED = "Ce témoignage a déjà été traité.";

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
      // holds such a link); online ones get the form's own, tighter limits in
      // the service.
      content: z
        .string()
        .trim()
        .min(1, "Le témoignage est requis")
        .max(20000, "Le témoignage est trop long"),
    })
    .optional(),
});

const TOO_LONG = {
  person_name: "Le nom est trop long",
  person_info: "Les informations sont trop longues",
  content: `Le témoignage est trop long (${ONLINE_TESTIMONY_MAX} caractères au plus)`,
} as const;

export default async function verifyRoutes(app: FastifyInstance) {
  // Look up the testimony behind a verification token.
  app.get<{ Params: { token: string } }>("/:token", async (req, reply) => {
    if (!tokenSchema.safeParse(req.params.token).success) return reply.notFound(NOT_FOUND);
    const result = await fetchTestimonyByToken(verifyClient(), req.params.token);
    if (result.kind === "fetchFailed") return reply.internalServerError(result.message);
    if (result.kind === "notFound") return reply.notFound(NOT_FOUND);
    if (result.kind === "expired") return reply.code(410).send({ error: EXPIRED });
    return result.testimony;
  });

  // Apply the citizen's decision: verify (with optional edits) or reject.
  app.post<{ Params: { token: string } }>(
    "/:token",
    { bodyLimit: 64 * 1024 },
    async (req, reply) => {
      if (!tokenSchema.safeParse(req.params.token).success) return reply.notFound(NOT_FOUND);
      const parsed = actionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
      }
      const { action, edits } = parsed.data;

      const result = await decideTestimony(verifyClient(), req.log, req.params.token, {
        action,
        edits,
      });
      switch (result.kind) {
        case "fetchFailed":
        case "dbError":
          return reply.internalServerError(result.message);
        case "notFound":
          return reply.notFound(NOT_FOUND);
        case "alreadyProcessed":
          return reply.code(409).send({
            error: `Ce témoignage a déjà été ${result.status === "verified" ? "validé" : "traité"}.`,
          });
        case "expired":
          return reply.code(410).send({ error: EXPIRED });
        case "editsTooLong":
          return reply.badRequest(TOO_LONG[result.field]);
        case "raced":
          return reply.code(409).send({ error: ALREADY_PROCESSED });
        case "rejected":
          return { status: "rejected" };
        case "verified":
          return { status: "verified", edited: Boolean(edits) };
      }
    },
  );
}
