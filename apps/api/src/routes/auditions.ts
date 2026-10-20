import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  createAuditionSchema,
  getCanonicalLocation,
  normalizeLocation,
  sanitizeText,
  updateAuditionSchema,
} from "@ac/shared";
import { publicClient } from "../supabase";
import { cached, invalidatePublicCaches, PUBLIC_CACHE_KEYS } from "../cache";
import { requireAdmin } from "../auth";
import { fetchPublishedAuditions, onlinePlaceOf, placeKeyOf } from "../services/locations";
import { logAudit } from "../services/audit";
import { auditionGone } from "../services/auditions";
import { getCachedEntry, loadGeocodeCache, resolve as resolveLocation } from "../geocode";
import {
  frDate,
  sendVerificationEmails,
  type SendReport,
  type VerificationRecipient,
} from "../services/emails";

/** Geocode an audition's lieu, waiting for it 3 seconds at most. */
async function geocodeBriefly(location: string): Promise<void> {
  await Promise.race([
    resolveLocation(getCanonicalLocation(location)).catch(() => null),
    new Promise((done) => setTimeout(done, 3000)),
  ]);
}

export default async function auditionRoutes(app: FastifyInstance) {
  // ---- Public reads (RLS as anon: published auditions + visible testimonies) ----

  // List published auditions with a count of their (visible) testimonies.
  app.get("/", async (_req, reply) => {
    // Cached: same published list for every visitor, changes only on admin
    // writes (which invalidate it). Public API only: the website itself no
    // longer reads it (its analyses are built from /api/map + /api/testimonies).
    try {
      return await cached(PUBLIC_CACHE_KEYS.auditions, 60_000, fetchPublishedAuditions);
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });

  // ---- Admin (role-gated; queries RLS-scoped to the caller) ----

  // Admin management list: whatever the caller's RLS lets them see. NOTE:
  // drafts only appear once the audition SELECT policy migration is applied.
  //
  // Each audition comes with its `area` — région, département, ville, lieu —
  // read from the geocode cache (no network), for the list's place filter: the
  // same places the Témoignages map files it under. A lieu never geocoded yet
  // (a draft's, say) is looked up in the background, for the next time.
  app.get("/admin/list", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const { data, error } = await req.supabase
      .from("auditions")
      .select(
        "id, title, date, location, content, status, created_by, audition_en_ligne, citycode, place",
      )
      .order("date", { ascending: false });
    if (error) return reply.internalServerError(error.message);
    await loadGeocodeCache();
    const rows = data ?? [];
    // Each lieu never geocoded, once, one after the other, in the background.
    // (Not an online audition's: its town hall is stored with it.)
    const missing = new Set(
      rows
        .filter((a) => !a.audition_en_ligne)
        .map((a) => getCanonicalLocation(a.location))
        .filter((c) => getCachedEntry(c) === undefined),
    );
    if (missing.size) {
      void (async () => {
        for (const c of missing) await resolveLocation(c).catch(() => null);
      })();
    }
    return rows.map((a) => {
      const canonical = placeKeyOf(a);
      const online = onlinePlaceOf(a);
      if (online) {
        return {
          ...a,
          area: {
            canonicalName: canonical,
            city: online.commune,
            departementCode: online.departementCode,
            departementName: online.departementName,
            region: online.region,
          },
        };
      }
      const entry = getCachedEntry(canonical);
      return {
        ...a,
        area: {
          canonicalName: canonical,
          city: entry?.city ?? null,
          departementCode: entry?.depCode ?? null,
          departementName: entry?.depName ?? null,
          region: entry?.region ?? null,
        },
      };
    });
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

    const { error: terr } =
      rows.length > 0 ? await req.supabase.from("testimonies").insert(rows) : { error: null };
    // Its lieu may be one never placed. Look it up now — briefly: a slow
    // geocoder must not hold the creation back (the map's own warm pass gets to
    // it otherwise) — so that the map, or the admin list's place filter (drafts
    // too), reloaded right after this answer already knows where it is.
    await geocodeBriefly(audition.location);
    // Again, now that everything is written: a read between the two inserts
    // may have cached the audition without its testimonies.
    invalidatePublicCaches();
    // Logged before the early return below: the audition exists by now whether
    // or not its testimonies went in.
    await logAudit(req.supabase, req.log, {
      actorId: req.user.id,
      action: "audition_created",
      targetType: "audition",
      targetId: auditionId,
      metadata: {
        title: audition.title,
        date: audition.date,
        location: audition.location,
        status: audition.status,
        testimonies: terr ? 0 : rows.length,
      },
    });
    if (terr) return reply.badRequest(terr.message);

    if (rows.length > 0) {
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

      // For the audit entry only: what the audition held, to tell which fields
      // the save really changed (the form sends them all every time). Best
      // effort: a draft is not readable until the policy migration is applied,
      // and the update below does not depend on it.
      const { data: before } = await req.supabase
        .from("auditions")
        .select("title, date, location, content, status, audition_en_ligne")
        .eq("id", req.params.id)
        .maybeSingle();

      // An online audition's town hall and month are fixed: its label is its
      // place on the map, and (citycode, date) is how the month's next
      // testimony finds it. Whatever the form sends for them is ignored.
      const online = before?.audition_en_ligne === true;
      const next = {
        ...(input.title !== undefined ? { title: sanitizeText(input.title) } : {}),
        ...(input.date !== undefined && !online ? { date: input.date } : {}),
        ...(input.location !== undefined && !online
          ? { location: normalizeLocation(input.location) }
          : {}),
        ...(input.content !== undefined ? { content: sanitizeText(input.content) } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      };

      // `count` is the number of rows the update touched — known without
      // reading them back, so it works for drafts too.
      const { error, count } = await req.supabase
        .from("auditions")
        .update(next, { count: "exact" })
        .eq("id", req.params.id);
      if (error) return reply.badRequest(error.message);
      // Moved to a lieu never placed: looked up now (see POST). Not an online
      // audition: renaming its town hall does not move it.
      if (next.location !== undefined && !before?.audition_en_ligne) {
        await geocodeBriefly(next.location);
      }
      invalidatePublicCaches();

      const submitted = Object.keys(next) as (keyof typeof next)[];
      // Unknown when the audition could not be read beforehand.
      const fields = before ? submitted.filter((f) => next[f] !== before[f]) : undefined;
      // Not for an id that matched nothing, nor for a save that changed
      // nothing: the log only says what happened.
      if (count !== 0 && submitted.length > 0 && (!fields || fields.length > 0)) {
        await logAudit(req.supabase, req.log, {
          actorId: req.user.id,
          action: "audition_updated",
          targetType: "audition",
          targetId: req.params.id,
          metadata: {
            title: next.title ?? before?.title,
            ...(fields ? { fields } : {}),
            // Only when it actually changed (or when the old one could not be read).
            ...(next.status !== undefined && next.status !== before?.status
              ? { status: next.status }
              : {}),
          },
        });
      }
      return { success: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      // For the audit entry only: what is about to disappear (best effort).
      const { data: before } = await req.supabase
        .from("auditions")
        .select("title, date, location")
        .eq("id", req.params.id)
        .maybeSingle();

      // Its testimonies first, as the old app does — `count`: how many really
      // went, for the audit entry.
      const { error: terr, count: deletedTestimonies } = await req.supabase
        .from("testimonies")
        .delete({ count: "exact" })
        .eq("audition_id", req.params.id);
      if (terr) return reply.badRequest(terr.message);

      // Emptied that way, the audition has already gone with its last
      // testimony (the database never leaves one empty): nothing is left for
      // this statement, and the audition is deleted all the same.
      const { error, count } = await req.supabase
        .from("auditions")
        .delete({ count: "exact" })
        .eq("id", req.params.id);
      // (Gone, if the caller could see it a moment ago.)
      const deleted =
        !error &&
        (count !== 0 ||
          (Boolean(deletedTestimonies) &&
            before !== null &&
            (await auditionGone(req.supabase, req.params.id))));

      if (deleted) {
        await logAudit(req.supabase, req.log, {
          actorId: req.user.id,
          action: "audition_deleted",
          targetType: "audition",
          targetId: req.params.id,
          metadata: {
            title: before?.title,
            date: before?.date,
            location: before?.location,
            testimonies: deletedTestimonies ?? undefined,
          },
        });
      } else if (deletedTestimonies) {
        // The audition stayed (delete failed, or matched nothing the caller may
        // delete) but testimonies of it are gone: that much did happen.
        await logAudit(req.supabase, req.log, {
          actorId: req.user.id,
          action: "testimony_deleted",
          targetType: "audition",
          targetId: req.params.id,
          metadata: {
            audition_id: req.params.id,
            audition_title: before?.title,
            testimonies: deletedTestimonies,
          },
        });
      }
      if (error) return reply.badRequest(error.message);
      invalidatePublicCaches();
      return reply.code(204).send();
    },
  );
}
