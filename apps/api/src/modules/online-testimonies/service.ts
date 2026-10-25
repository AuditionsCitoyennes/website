import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import {
  composeAnswers,
  sanitizeText,
  type Database,
  type Json,
  type OnlineTestimonyInput,
} from "@ac/shared";
import { config, emailMode, hasEmail, hasServiceRole, isDev } from "../../config";
import { logAudit } from "../../lib/audit";
import { EmailRetryableError } from "../../lib/email/resend";
import { sendOnlineVerificationEmail } from "../../lib/email/verification";
import { allowGlobalHit } from "../../lib/rateLimit";
import { PlaceError, resolveTownHall } from "./townHall";

// "Témoigner": a visitor — nobody signed in — sends a testimony from the site.
//
// It joins the online audition of the month of their commune's town hall
// (created by the month's first testimony), and stays unpublished until the
// link emailed to them is clicked (/verifier/:token, modules/verification).
// One testimony per email per week. Everything that must not race — the
// weekly quota, the month's audition — happens in one database call
// (submit_online_testimony, service role only).
//
// Nothing public changes here — a pending testimony is not shown anywhere —
// so the public caches are NOT invalidated: an anonymous form must not be a
// way to flush them on every request.

type Client = SupabaseClient<Database>;

export const HOUR = 60 * 60 * 1000;

/**
 * Local development, emails only logged: the link the email would have
 * carried goes back to the page (and to the log) instead, so the form can be
 * tried end to end. Never anywhere else (APP_ENV fails closed).
 */
export const devLink = isDev && emailMode === "log";

/**
 * Without the service role nothing can be written, and without emails nothing
 * could ever be validated: refuse before writing anything.
 */
export const available = hasServiceRole && hasEmail;

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

export type SubmitResult =
  | { kind: "ok"; townHall: string; title: string; devVerificationUrl?: string }
  /** A robot: dropped, but answered as if it had worked. */
  | { kind: "robot" }
  /** The commune could not be resolved (400) or its API is down (503). */
  | { kind: "placeRejected"; status: 400 | 503; message: string }
  /** The site-wide ceiling for the day is spent. */
  | { kind: "saturated" }
  /** This address already testified these 7 days. */
  | { kind: "weeklyQuota" }
  /** The database call failed for another reason. */
  | { kind: "notSaved" }
  /** The email was refused for good; `rolledBack` says whether the testimony and its quota row went. */
  | { kind: "emailFailed"; rolledBack: boolean }
  /** The email service did not answer, twice: the testimony stays, the visitor may try again after `retryAfterSeconds`. */
  | { kind: "emailRetryable"; retryAfterSeconds: number };

/** A visitor's testimony, from a well-formed form, past the per-visitor limit. */
export async function submitOnlineTestimony(
  client: Client,
  log: FastifyBaseLogger,
  input: OnlineTestimonyInput,
): Promise<SubmitResult> {
  // A robot: the field no person sees is filled in, or the form was sent
  // faster than anyone could write. Answered as if it had worked.
  if (input.website || (input.elapsed_ms !== undefined && input.elapsed_ms < 3000)) {
    log.info(
      { honeypot: Boolean(input.website), elapsedMs: input.elapsed_ms },
      "online testimony dropped as a robot",
    );
    return { kind: "robot" };
  }

  let townHall;
  try {
    townHall = await resolveTownHall(input.commune_code);
  } catch (e) {
    if (e instanceof PlaceError) {
      if (e.status === 503) log.warn({ err: e.cause }, "geo.api.gouv.fr unavailable");
      return { kind: "placeRejected", status: e.status, message: e.message };
    }
    throw e;
  }

  // And a ceiling for the whole site, spent only by well-formed submissions
  // about to send an email — not by junk anyone can fire at it.
  if (!allowGlobalHit(300, 24 * HOUR)) return { kind: "saturated" };

  const month = currentMonth();
  const title = auditionTitle(month.name);
  const token = randomUUID();
  const { data, error } = await client.rpc("submit_online_testimony", {
    p_email_hash: emailHash(input.email),
    p_person_name: sanitizeText(input.person_name) || "Anonyme",
    // The function takes NULL for no info; the generated type does not say so.
    p_person_info: (input.person_info ? sanitizeText(input.person_info) : null) as string,
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
    // No date: when an address last testified would tie it to its
    // published (anonymous) testimony, for anyone who types it in.
    if (error.code === "PT429") return { kind: "weeklyQuota" };
    log.error({ err: error }, "submit_online_testimony failed");
    return { kind: "notSaved" };
  }
  const result = data as { testimony_id: string; audition_id: string; audition_created: boolean };

  // Development without an email key: no email; the link the email would
  // have carried goes back to the page (and to the log) instead.
  if (devLink) {
    const devVerificationUrl = `${config.PUBLIC_APP_URL}/verifier/${token}`;
    log.warn({ devVerificationUrl }, "online testimony: dev mode, email NOT sent");
    return { kind: "ok", townHall: townHall.location, title, devVerificationUrl };
  }

  try {
    await sendOnlineVerificationEmail(input.email, token, townHall.location, title);
  } catch (e) {
    if (e instanceof EmailRetryableError) {
      // Resend may well have accepted the email (a timeout past its answer):
      // the testimony stays, its link may be in the inbox. Only its quota
      // row goes, so that the visitor, told to try again in a moment, is not
      // refused for a week by the weekly quota — one more pending testimony
      // at worst, never a dead link.
      log.error({ err: e }, "online testimony: verification email not sent, retryable");
      const quota = await client
        .from("online_testimony_submissions")
        .delete()
        .eq("testimony_id", result.testimony_id);
      if (quota.error) {
        log.error(
          { quota: quota.error, testimonyId: result.testimony_id },
          "online testimony: quota row not freed after a retryable email failure",
        );
      }
      return { kind: "emailRetryable", retryAfterSeconds: e.retryAfterSeconds ?? 60 };
    }
    // Refused for good — the address, most likely. Without its link the
    // testimony could never be published: it goes, and so does its quota row
    // (an address mistyped must not be locked out for a week). The month's
    // audition goes with it if nobody else has joined it meanwhile (the
    // database never leaves an audition empty).
    log.error({ err: e }, "online testimony: verification email refused");
    const quota = await client
      .from("online_testimony_submissions")
      .delete()
      .eq("testimony_id", result.testimony_id);
    const row = await client.from("testimonies").delete().eq("id", result.testimony_id);
    if (quota.error || row.error) {
      log.error(
        { quota: quota.error, row: row.error, testimonyId: result.testimony_id },
        "online testimony: rollback after a failed email incomplete",
      );
      return { kind: "emailFailed", rolledBack: false };
    }
    return { kind: "emailFailed", rolledBack: true };
  }

  await logAudit(client, log, {
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

  return { kind: "ok", townHall: townHall.location, title };
}
