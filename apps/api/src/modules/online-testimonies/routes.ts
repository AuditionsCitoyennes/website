import type { FastifyInstance } from "fastify";
import { onlineTestimonySchema } from "@ac/shared";
import { rateLimitFactor } from "../../config";
import { adminClient } from "../../lib/supabase";
import { allowHit, clientKey } from "../../lib/rateLimit";
import { visitorIp } from "../../lib/visitor";
import { available, HOUR, submitOnlineTestimony } from "./service";

// "Témoigner": a visitor — nobody signed in — sends a testimony from the site
// (the rules are in service.ts). Nothing public changes here, so the public
// caches are NOT invalidated.

export default async function onlineTestimonyRoutes(app: FastifyInstance) {
  app.post("/", { bodyLimit: 32 * 1024 }, async (req, reply) => {
    // Refused before anything is parsed or written when the service role or
    // the emails are missing (in development without an email key, the link
    // is handed back instead, so the form can be tried end to end).
    if (!available) {
      return reply.serviceUnavailable(
        "Le dépôt de témoignages en ligne n'est pas disponible pour le moment.",
      );
    }

    // A few tries an hour per visitor — this form sends emails to whatever
    // address is typed into it.
    if (!allowHit(`ip:${clientKey(visitorIp(req))}`, 5 * rateLimitFactor, HOUR)) {
      return reply.tooManyRequests("Trop de tentatives. Réessayez un peu plus tard.");
    }

    const parsed = onlineTestimonySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? "Formulaire invalide");
    }

    const result = await submitOnlineTestimony(adminClient, req.log, parsed.data);
    switch (result.kind) {
      case "robot":
        return reply.code(201).send({ ok: true });
      case "placeRejected":
        return reply.code(result.status).send({ message: result.message });
      case "saturated":
        return reply.tooManyRequests(
          "Le dépôt de témoignages est momentanément saturé. Réessayez plus tard.",
        );
      case "weeklyQuota":
        return reply.tooManyRequests(
          "Un seul témoignage par semaine et par adresse email : cette adresse en a déjà envoyé un ces 7 derniers jours.",
        );
      case "notSaved":
        return reply.internalServerError("Votre témoignage n'a pas pu être enregistré.");
      case "emailRetryable":
        // When the form may be sent again — the weekly quota does not stand
        // in the way, see the service.
        reply.header("Retry-After", String(result.retryAfterSeconds));
        return reply.serviceUnavailable(
          "L'email de validation n'a pas pu être envoyé pour le moment : le service d'envoi ne répond pas. Réessayez dans quelques minutes.",
        );
      case "emailFailed":
        return reply.badGateway(
          result.rolledBack
            ? "L'email de validation n'a pas pu être envoyé. Vérifiez l'adresse, ou réessayez dans quelques minutes."
            : "L'email de validation n'a pas pu être envoyé. Contactez-nous si le problème persiste.",
        );
      case "ok": {
        const { townHall, title, devVerificationUrl } = result;
        return reply
          .code(201)
          .send(
            devVerificationUrl
              ? { ok: true, townHall, title, devVerificationUrl }
              : { ok: true, townHall, title },
          );
      }
    }
  });
}
