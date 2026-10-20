import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { composeAnswers, onlineTestimonySchema, sanitizeText, type Json } from "@ac/shared";
import { adminClient } from "../supabase";
import { config, hasEmail, hasServiceRole, isDev } from "../config";
import { logAudit } from "../services/audit";
import { sendOnlineVerificationEmail } from "../services/emails";
import { PlaceError, resolveTownHall } from "../services/places";
import { allowGlobalHit, allowHit, clientKey } from "../services/rateLimit";

// "Témoigner": a visitor — nobody signed in — sends a testimony from the site.
//
// It joins the online audition of the month of their commune's town hall
// (created by the month's first testimony), and stays unpublished until the
// link emailed to them is clicked (/verifier/:token, routes/verify.ts). One
// testimony per email per week. Everything that must not race — the weekly
// quota, the month's audition — happens in one database call
// (submit_online_testimony, service role only).
//
// Nothing public changes here — a pending testimony is not shown anywhere —
// so the public caches are NOT invalidated: an anonymous form must not be a
// way to flush them on every request.

const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

const HOUR = 60 * 60 * 1000;

/** This month in Paris: its first day, and its name. */
function currentMonth(): { first: string; name: string; year: string } {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  return { first: `${year}-${month}-01`, name: MONTHS[Number(month) - 1], year };
}

/** "Audition en ligne de mai", "d'avril", "d'août", "d'octobre". */
function auditionTitle(monthName: string): string {
  return `Audition en ligne ${/^[aeiou]/.test(monthName) ? "d'" : "de "}${monthName}`;
}

/**
 * What the weekly quota knows of an address: a hash of the mailbox it reaches
 * — lowercased, without "+tag" (name+1@, name+2@… are one mailbox), and for
 * Gmail without dots (j.doe@ and jdoe@ are one mailbox there).
 */
function emailHash(email: string): string {
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at).trim().toLowerCase();
  let domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return createHash("sha256").update(`${local}@${domain}`).digest("hex");
}

export default async function onlineTestimonyRoutes(app: FastifyInstance) {
  app.post("/", { bodyLimit: 32 * 1024 }, async (req, reply) => {
    // Without the service role nothing can be written, and without emails
    // nothing could ever be validated: refuse before writing anything. (In
    // development without an email key, the link is handed back instead —
    // see below — so the form can be tried end to end.)
    const devLink = isDev && !hasEmail;
    if (!hasServiceRole || (!hasEmail && !devLink)) {
      return reply.serviceUnavailable(
        "Le dépôt de témoignages en ligne n'est pas disponible pour le moment.",
      );
    }

    // A few tries an hour per visitor — this form sends emails to whatever
    // address is typed into it.
    if (!allowHit(`ip:${clientKey(req.ip)}`, 5, HOUR)) {
      return reply.tooManyRequests("Trop de tentatives. Réessayez un peu plus tard.");
    }

    const parsed = onlineTestimonySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? "Formulaire invalide");
    }
    const input = parsed.data;

    // A robot: the field no person sees is filled in, or the form was sent
    // faster than anyone could write. Answered as if it had worked.
    if (input.website || (input.elapsed_ms !== undefined && input.elapsed_ms < 3000)) {
      req.log.info(
        { honeypot: Boolean(input.website), elapsedMs: input.elapsed_ms },
        "online testimony dropped as a robot",
      );
      return reply.code(201).send({ ok: true });
    }

    let townHall;
    try {
      townHall = await resolveTownHall(input.commune_code);
    } catch (e) {
      if (e instanceof PlaceError) {
        if (e.status === 503) req.log.warn({ err: e.cause }, "geo.api.gouv.fr unavailable");
        return reply.code(e.status).send({ message: e.message });
      }
      throw e;
    }

    // And a ceiling for the whole site, spent only by well-formed submissions
    // about to send an email — not by junk anyone can fire at it.
    if (!allowGlobalHit(300, 24 * HOUR)) {
      return reply.tooManyRequests(
        "Le dépôt de témoignages est momentanément saturé. Réessayez plus tard.",
      );
    }

    const month = currentMonth();
    const title = auditionTitle(month.name);
    const token = randomUUID();
    const { data, error } = await adminClient.rpc("submit_online_testimony", {
      p_email_hash: emailHash(input.email),
      p_person_name: sanitizeText(input.person_name) || "Anonyme",
      p_person_info: input.person_info ? sanitizeText(input.person_info) : null,
      // Each answer under its question, in one text (see AUDITION_QUESTIONS).
      p_content: composeAnswers(input.answers.map(sanitizeText)),
      p_citycode: townHall.key,
      p_location: townHall.location,
      p_place: townHall.place as unknown as Json,
      p_month: month.first,
      p_title: title,
      p_audition_content: `Témoignages déposés en ligne sur le site en ${month.name} ${month.year}, rattachés à la ${townHall.location}.`,
      p_token: token,
    });
    if (error) {
      if (error.code === "PT429") {
        // No date: when an address last testified would tie it to its
        // published (anonymous) testimony, for anyone who types it in.
        return reply.tooManyRequests(
          "Un seul témoignage par semaine et par adresse email : cette adresse en a déjà envoyé un ces 7 derniers jours.",
        );
      }
      req.log.error({ err: error }, "submit_online_testimony failed");
      return reply.internalServerError("Votre témoignage n'a pas pu être enregistré.");
    }
    const result = data as { testimony_id: string; audition_id: string; audition_created: boolean };

    // Development without an email key: no email; the link the email would
    // have carried goes back to the page (and to the log) instead.
    if (devLink) {
      const devVerificationUrl = `${config.PUBLIC_APP_URL}/verifier/${token}`;
      req.log.warn({ devVerificationUrl }, "online testimony: dev mode, email NOT sent");
      return reply
        .code(201)
        .send({ ok: true, townHall: townHall.location, title, devVerificationUrl });
    }

    try {
      await sendOnlineVerificationEmail(input.email, token, townHall.location, title);
    } catch (e) {
      // Without its link the testimony could never be published: it goes, and
      // so does its quota row (an address mistyped must not be locked out for
      // a week). The month's audition goes with it if nobody else has joined
      // it meanwhile (the database never leaves an audition empty).
      req.log.error({ err: e }, "online testimony: verification email failed");
      const quota = await adminClient
        .from("online_testimony_submissions")
        .delete()
        .eq("testimony_id", result.testimony_id);
      const row = await adminClient.from("testimonies").delete().eq("id", result.testimony_id);
      if (quota.error || row.error) {
        req.log.error(
          { quota: quota.error, row: row.error, testimonyId: result.testimony_id },
          "online testimony: rollback after a failed email incomplete",
        );
        return reply.badGateway(
          "L'email de validation n'a pas pu être envoyé. Contactez-nous si le problème persiste.",
        );
      }
      return reply.badGateway(
        "L'email de validation n'a pas pu être envoyé. Vérifiez l'adresse, ou réessayez dans quelques minutes.",
      );
    }

    await logAudit(adminClient, req.log, {
      actorId: null,
      action: "testimony_submitted",
      targetType: "testimony",
      targetId: result.testimony_id,
      metadata: {
        audition_id: result.audition_id,
        audition_title: title,
        town_hall: townHall.location,
        audition_created: result.audition_created,
      },
    });

    return reply.code(201).send({ ok: true, townHall: townHall.location, title });
  });
}
