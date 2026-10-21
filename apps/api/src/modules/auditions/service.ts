import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  getCanonicalLocation,
  normalizeLocation,
  sanitizeText,
  type Audition,
  type AuditionStatus,
  type AuditionWithCount,
  type CreateAuditionInput,
  type Database,
  type OnlinePlace,
  type Testimony,
  type UpdateAuditionInput,
} from "@ac/shared";
import { publicClient } from "../../lib/supabase";
import { invalidatePublicCaches } from "../../lib/publicCache";
import { logAudit } from "../../lib/audit";
import { frDate } from "../../lib/dates";
import {
  sendVerificationEmails,
  type SendReport,
  type VerificationRecipient,
} from "../../lib/email/verification";
import { getCachedEntry, loadGeocodeCache, resolve as resolveLocation } from "../geo/geocode";

type Client = SupabaseClient<Database>;

/** The database refused: its message, for the route to send back. */
export interface DbError {
  kind: "dbError";
  message: string;
}

/**
 * Where an audition is filed on the map. An online audition's location is its
 * town hall's name, already unique and exact: it is never run through the
 * keyword rules of getCanonicalLocation (they would turn "Mairie de
 * Montbron" into Bron's médiathèque).
 */
export function placeKeyOf(a: { location: string; audition_en_ligne?: boolean | null }): string {
  return a.audition_en_ligne ? a.location : getCanonicalLocation(a.location);
}

/** An online audition's town hall, as stored with it (null for any other). */
export function onlinePlaceOf(a: {
  audition_en_ligne?: boolean | null;
  place?: unknown;
}): OnlinePlace | null {
  if (!a.audition_en_ligne || !a.place || typeof a.place !== "object") return null;
  const p = a.place as Partial<OnlinePlace>;
  return typeof p.lat === "number" && typeof p.lng === "number" ? (p as OnlinePlace) : null;
}

/** Published auditions with their visible (verified) testimony counts. */
export async function fetchPublishedAuditions(): Promise<AuditionWithCount[]> {
  const { data, error } = await publicClient
    .from("auditions")
    .select("*, testimonies(count)")
    .eq("status", "published")
    .order("date", { ascending: false });
  if (error) throw new Error(error.message);

  return (
    (data ?? [])
      .map((row) => {
        const { testimonies, ...audition } = row as typeof row & {
          testimonies?: { count: number }[];
        };
        return { ...audition, testimony_count: testimonies?.[0]?.count ?? 0 };
      })
      // An online audition is public once it holds a verified testimony. The
      // database already hides it until then; this holds even if it did not.
      .filter((a) => !(a.audition_en_ligne && a.testimony_count === 0))
  );
}

/**
 * Whether an audition is gone — asked after one of its testimonies was
 * deleted: the database deletes an audition along with its last testimony
 * (trigger drop_emptied_audition). Only meaningful for an audition the same
 * client could see just before; false when the lookup fails, which proves
 * nothing.
 */
export async function auditionGone(client: Client, auditionId: string): Promise<boolean> {
  const { data, error } = await client
    .from("auditions")
    .select("id")
    .eq("id", auditionId)
    .maybeSingle();
  return !error && !data;
}

// ---- Public detail --------------------------------------------------------

export type PublishedAudition = Audition & {
  testimonies: Pick<
    Testimony,
    | "id"
    | "person_name"
    | "person_info"
    | "content"
    | "topics"
    | "verification_status"
    | "created_at"
  >[];
};

/**
 * One published audition with its visible testimonies. Explicit testimony
 * columns: RLS limits rows, not columns — `*` would leak email addresses and
 * verification tokens (the old app had this bug).
 */
export async function fetchPublishedAudition(
  client: Client,
  id: string,
): Promise<{ kind: "ok"; audition: PublishedAudition } | { kind: "notFound" } | DbError> {
  const { data, error } = await client
    .from("auditions")
    .select(
      "*, testimonies(id, person_name, person_info, content, topics, verification_status, created_at)",
    )
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  if (error) return { kind: "dbError", message: error.message };
  if (!data) return { kind: "notFound" };
  return { kind: "ok", audition: data };
}

// ---- Admin list -----------------------------------------------------------

/** Région, département, ville, lieu: the places the Témoignages map files an audition under. */
export interface AuditionArea {
  canonicalName: string;
  city: string | null;
  departementCode: string | null;
  departementName: string | null;
  region: string | null;
}

export type AdminAudition = Pick<
  Audition,
  | "id"
  | "title"
  | "date"
  | "location"
  | "content"
  | "status"
  | "created_by"
  | "audition_en_ligne"
  | "citycode"
  | "place"
> & { area: AuditionArea };

/**
 * Whatever the caller's RLS lets them see. NOTE: drafts only appear once the
 * audition SELECT policy migration is applied.
 *
 * Each audition comes with its `area`, read from the geocode cache (no
 * network), for the list's place filter: the same places the Témoignages map
 * files it under. A lieu never geocoded yet (a draft's, say) is looked up in
 * the background, for the next time.
 */
export async function fetchAdminAuditions(
  client: Client,
): Promise<{ kind: "ok"; auditions: AdminAudition[] } | DbError> {
  const { data, error } = await client
    .from("auditions")
    .select(
      "id, title, date, location, content, status, created_by, audition_en_ligne, citycode, place",
    )
    .order("date", { ascending: false });
  if (error) return { kind: "dbError", message: error.message };
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
  const auditions = rows.map((a) => {
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
  return { kind: "ok", auditions };
}

// ---- Writes ---------------------------------------------------------------

/** Geocode an audition's lieu, waiting for it 3 seconds at most. */
async function geocodeBriefly(location: string): Promise<void> {
  await Promise.race([
    resolveLocation(getCanonicalLocation(location)).catch(() => null),
    new Promise((done) => setTimeout(done, 3000)),
  ]);
}

export interface NewAudition {
  id: string;
  title: string;
  date: string;
  location: string;
  content: string;
  status: AuditionStatus;
  created_by: string;
}

export interface NewTestimony {
  id: string;
  audition_id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  email: string | null;
  topics: string[] | null;
  verification_status: string | null;
  verification_token: string | null;
  created_by: string;
}

export type CreateAuditionResult =
  | {
      kind: "ok";
      audition: NewAudition;
      testimonies: NewTestimony[];
      emailReport: SendReport | null;
    }
  | DbError;

/**
 * Create an audition with optional inline testimonies; testimonies with an
 * email get a verification token and a batch verification email.
 * The id is generated server-side so no RLS-filtered readback is needed
 * (drafts are not SELECT-visible until the policy migration is applied).
 */
export async function createAudition(
  client: Client,
  log: FastifyBaseLogger,
  actorId: string,
  input: CreateAuditionInput,
): Promise<CreateAuditionResult> {
  const { testimonies } = input;

  const auditionId = randomUUID();
  const audition: NewAudition = {
    id: auditionId,
    title: sanitizeText(input.title),
    date: input.date,
    location: normalizeLocation(input.location),
    content: sanitizeText(input.content),
    status: input.status,
    created_by: actorId,
  };

  const { error } = await client.from("auditions").insert(audition);
  if (error) return { kind: "dbError", message: error.message };
  invalidatePublicCaches();

  let emailReport: SendReport | null = null;

  const valid = testimonies.filter((t) => t.person_name && t.content);
  const rows: NewTestimony[] = valid.map((t) => {
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
      created_by: actorId,
    };
  });

  const { error: terr } =
    rows.length > 0 ? await client.from("testimonies").insert(rows) : { error: null };
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
  await logAudit(client, log, {
    actorId,
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
  if (terr) return { kind: "dbError", message: terr.message };

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
        log.warn({ err: e }, "verification emails failed");
        emailReport = { success: false, sent: 0, failed: recipients.length, results: [] };
      }
    }
  }

  return { kind: "ok", audition, testimonies: rows, emailReport };
}

/**
 * Update an audition. No RLS readback: a published->draft transition makes
 * the row invisible to SELECT until the policy migration is applied, which
 * would otherwise turn a successful update into a phantom 404.
 */
export async function updateAudition(
  client: Client,
  log: FastifyBaseLogger,
  actorId: string,
  id: string,
  input: UpdateAuditionInput,
): Promise<{ kind: "ok" } | DbError> {
  // For the audit entry only: what the audition held, to tell which fields
  // the save really changed (the form sends them all every time). Best
  // effort: a draft is not readable until the policy migration is applied,
  // and the update below does not depend on it.
  const { data: before } = await client
    .from("auditions")
    .select("title, date, location, content, status, audition_en_ligne")
    .eq("id", id)
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
  const { error, count } = await client
    .from("auditions")
    .update(next, { count: "exact" })
    .eq("id", id);
  if (error) return { kind: "dbError", message: error.message };
  // Moved to a lieu never placed: looked up now (see createAudition). Not an
  // online audition: renaming its town hall does not move it.
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
    await logAudit(client, log, {
      actorId,
      action: "audition_updated",
      targetType: "audition",
      targetId: id,
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
  return { kind: "ok" };
}

/** Delete an audition: its testimonies first, as the old app does, then itself. */
export async function deleteAudition(
  client: Client,
  log: FastifyBaseLogger,
  actorId: string,
  id: string,
): Promise<{ kind: "ok" } | DbError> {
  // For the audit entry only: what is about to disappear (best effort).
  const { data: before } = await client
    .from("auditions")
    .select("title, date, location")
    .eq("id", id)
    .maybeSingle();

  // Its testimonies first — `count`: how many really went, for the audit entry.
  const { error: terr, count: deletedTestimonies } = await client
    .from("testimonies")
    .delete({ count: "exact" })
    .eq("audition_id", id);
  if (terr) return { kind: "dbError", message: terr.message };

  // Emptied that way, the audition has already gone with its last
  // testimony (the database never leaves one empty): nothing is left for
  // this statement, and the audition is deleted all the same.
  const { error, count } = await client.from("auditions").delete({ count: "exact" }).eq("id", id);
  // (Gone, if the caller could see it a moment ago.)
  const deleted =
    !error &&
    (count !== 0 ||
      (Boolean(deletedTestimonies) && before !== null && (await auditionGone(client, id))));

  if (deleted) {
    await logAudit(client, log, {
      actorId,
      action: "audition_deleted",
      targetType: "audition",
      targetId: id,
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
    await logAudit(client, log, {
      actorId,
      action: "testimony_deleted",
      targetType: "audition",
      targetId: id,
      metadata: {
        audition_id: id,
        audition_title: before?.title,
        testimonies: deletedTestimonies,
      },
    });
  }
  if (error) return { kind: "dbError", message: error.message };
  invalidatePublicCaches();
  return { kind: "ok" };
}
