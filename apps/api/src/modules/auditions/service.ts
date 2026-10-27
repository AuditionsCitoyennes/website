import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  getKnownCoordinates,
  normalizeLocation,
  sanitizeText,
  type Audition,
  type AuditionArea,
  type AuditionStatus,
  type AuditionWithCount,
  type CreateAuditionInput,
  type Database,
  type PlacePick,
  type Testimony,
  type UpdateAuditionInput,
} from "@ac/shared";
import { mapSource } from "../../config";
import { publicClient } from "../../lib/supabase";
import { PAGE, quoted, selectAll } from "../../lib/paging";
import { guardPublishedAuditions } from "../../lib/guards";
import {
  invalidatePublicCaches,
  legacyCache,
  PUBLIC_CACHE_KEYS,
  PUBLIC_CACHE_TTL_MS,
} from "../../lib/publicCache";
import { logAudit } from "../../lib/audit";
import { frDate } from "../../lib/dates";
import {
  sendVerificationEmails,
  type SendReport,
  type VerificationRecipient,
} from "../../lib/email/verification";
import {
  getCachedEntry,
  loadGeocodeCache,
  placeLieux,
  resolve as resolveLocation,
} from "../geo/geocode";
import { placementOf, type GeoEntry } from "../geo/match";
import { readGeoUnits, upsertGeoUnits } from "../places/geoUnits";
import { areaOfRow, storedPlacementOf } from "../places/groups";
import { onlinePlaceOf, placeKeyOf } from "../places/lieu";
import { keepPlacedAbroad, placeLieu, type Placement } from "../places/placeLieu";
import { nudgePlacementJob } from "../places/placementJob";

type Client = SupabaseClient<Database>;

/** The database refused: its message, for the route to send back. */
export interface DbError {
  kind: "dbError";
  message: string;
}

export { onlinePlaceOf, placeKeyOf };

/** The auditions after `last` in `date desc, id` order, as a PostgREST `or` filter. */
const afterByDate = (last: { date: string; id: string }) =>
  `date.lt.${last.date},and(date.eq.${last.date},id.gt.${last.id})`;

/**
 * Published auditions with their visible (verified) testimony counts, newest
 * first. Same-day auditions come by id: the pages need a total order, and the
 * map's groups, built in this order, come out the same on every fill.
 */
export async function fetchPublishedAuditions(): Promise<AuditionWithCount[]> {
  const { data, error } = await selectAll((last?: Audition) => {
    const q = publicClient
      .from("auditions")
      .select("*")
      .eq("status", "published")
      .order("date", { ascending: false })
      .order("id");
    return (last ? q.or(afterByDate(last)) : q).limit(PAGE);
  });
  if (error) throw new Error(error.message);

  // The counts come from the audition_testimony_counts view: the public API
  // may only read some columns of testimonies, which an embedded
  // `testimonies(count)` does not survive. One row per audition that has
  // testimonies (drafts included).
  const { data: countRows, error: countError } = await selectAll(
    (last?: { audition_id: string | null }) => {
      // The audition-less row is of no use here, and as a page's last row it
      // would make the next page's keyset `gt.null`.
      const q = publicClient
        .from("audition_testimony_counts")
        .select("audition_id, total_count, verified_count")
        .not("audition_id", "is", null)
        .order("audition_id");
      return (last ? q.gt("audition_id", last.audition_id) : q).limit(PAGE);
    },
  );
  if (countError) throw new Error(countError.message);
  const counts = new Map<string, { total: number; verified: number }>();
  for (const c of countRows) {
    if (c.audition_id) {
      counts.set(c.audition_id, { total: c.total_count ?? 0, verified: c.verified_count ?? 0 });
    }
  }

  return (
    data
      .map((audition) => {
        const c = counts.get(audition.id);
        // What the public sees: every testimony of an ordinary audition, only
        // the verified ones of an online audition. The view does not apply the
        // testimonies policies that hide the others, so the rule is restated.
        const testimony_count = (audition.audition_en_ligne ? c?.verified : c?.total) ?? 0;
        return { ...audition, testimony_count };
      })
      // An online audition is public once it holds a verified testimony. The
      // database already hides it until then; this holds even if it did not.
      .filter((a) => !(a.audition_en_ligne && a.testimony_count === 0))
  );
}

/**
 * The published auditions as /api/auditions sends them and /api/map groups
 * them, refused past AUDITIONS_MAX (lib/guards.ts).
 */
export async function guardedPublishedAuditions(): Promise<AuditionWithCount[]> {
  await guardPublishedAuditions();
  return fetchPublishedAuditions();
}

/**
 * The published auditions through the legacy cache: one Supabase pull per
 * TTL for the list, the map's two builds and the geocoder's warm pass, and
 * one invalidation (invalidatePublicCaches) for all.
 */
export function cachedPublishedAuditions(): Promise<AuditionWithCount[]> {
  return legacyCache.value(PUBLIC_CACHE_KEYS.auditions, guardedPublishedAuditions, {
    ttlMs: PUBLIC_CACHE_TTL_MS.auditions,
  });
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

type DetailTestimony = PublishedAudition["testimonies"][number];

/**
 * The testimonies after `last` in the map panel's order (`created_at` nulls
 * first, then id desc: design A18), as a PostgREST `or` filter.
 */
const afterInPanelOrder = (last: DetailTestimony) =>
  last.created_at === null
    ? `created_at.not.is.null,and(created_at.is.null,id.lt.${last.id})`
    : `created_at.gt.${quoted(last.created_at)},and(created_at.eq.${quoted(last.created_at)},id.lt.${last.id})`;

/**
 * Every testimony of one audition the client may see, read on its own and
 * paged, in the map panel's order. Explicit columns: RLS limits rows, not
 * columns — `*` would leak email addresses and verification tokens (the old
 * app had this bug).
 */
function fetchAuditionTestimonies(client: Client, auditionId: string) {
  return selectAll((last?: DetailTestimony) => {
    const q = client
      .from("testimonies")
      .select("id, person_name, person_info, content, topics, verification_status, created_at")
      .eq("audition_id", auditionId)
      .order("created_at", { nullsFirst: true })
      .order("id", { ascending: false });
    return (last ? q.or(afterInPanelOrder(last)) : q).limit(PAGE);
  });
}

/**
 * An audition read with its testimonies embedded, made whole. max_rows cuts
 * an embedded list too: one of PAGE rows may be short, and is read again on
 * its own, in the map panel's order. A shorter one is kept as read, in the
 * database's order, as before paging.
 */
export async function withWholeTestimonies<
  A extends { id: string; testimonies: DetailTestimony[] },
>(client: Client, audition: A): Promise<{ kind: "ok"; audition: A } | DbError> {
  if (audition.testimonies.length < PAGE) return { kind: "ok", audition };
  const { data, error } = await fetchAuditionTestimonies(client, audition.id);
  if (error) return { kind: "dbError", message: error.message };
  return { kind: "ok", audition: { ...audition, testimonies: data } };
}

/**
 * One published audition with its visible testimonies. Explicit testimony
 * columns, as in fetchAuditionTestimonies.
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
  return withWholeTestimonies(client, data);
}

// ---- Admin list -----------------------------------------------------------

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

/** The admin list's own columns, as before map phase 1. */
const ADMIN_LIST_COLUMNS =
  "id, title, date, location, content, status, created_by, audition_en_ligne, citycode, place";
/** With where each audition is stored as placed (MAP_SOURCE=db). */
const ADMIN_PLACED_COLUMNS =
  "id, title, date, location, content, status, created_by, audition_en_ligne, citycode, place, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, place_stale, lieu_id";

/** The list's own fields: not the stored place. */
const ownFields = (a: Omit<AdminAudition, "area">): Omit<AdminAudition, "area"> => ({
  id: a.id,
  title: a.title,
  date: a.date,
  location: a.location,
  content: a.content,
  status: a.status,
  created_by: a.created_by,
  audition_en_ligne: a.audition_en_ligne,
  citycode: a.citycode,
  place: a.place,
});

interface ListLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Whatever the caller's RLS lets them see. NOTE: drafts only appear once the
 * audition SELECT policy migration is applied.
 *
 * Each audition comes with its `area`, for the list's place filter: the same
 * places the Témoignages map files it under — and how precisely it is placed
 * there, so that a lieu left off the map is seen, and its text fixed. From the
 * place stored on the row (MAP_SOURCE=db; the geocoder's areas when the
 * stored places cannot be read), else from the geocode cache, where a lieu
 * never geocoded yet (a draft's, say) is looked up in the background, for the
 * next time.
 */
export async function fetchAdminAuditions(
  client: Client,
  source: "db" | "geocoder" = mapSource,
  log?: ListLogger,
): Promise<{ kind: "ok"; auditions: AdminAudition[] } | DbError> {
  if (source === "db") {
    const stored = await adminListFromStoredPlaces(client);
    if (stored.kind === "ok") return stored;
    log?.warn(
      { err: stored.message },
      "admin list: stored places not readable, the geocoder's areas meanwhile",
    );
  }
  return adminListFromGeocoder(client);
}

async function adminListFromStoredPlaces(
  client: Client,
): Promise<{ kind: "ok"; auditions: AdminAudition[] } | DbError> {
  // Newest first, same-day auditions by id (a total order, for the pages).
  const { data: rows, error } = await selectAll((last?: { date: string; id: string }) => {
    const q = client
      .from("auditions")
      .select(ADMIN_PLACED_COLUMNS)
      .order("date", { ascending: false })
      .order("id");
    return (last ? q.or(afterByDate(last)) : q).limit(PAGE);
  });
  if (error) return { kind: "dbError", message: error.message };
  let units;
  try {
    units = await readGeoUnits(rows.map((a) => a.place_path));
  } catch (e) {
    return { kind: "dbError", message: e instanceof Error ? e.message : String(e) };
  }
  // The rows not placed yet are "pending", with the geocoder's area when its
  // cache has one: settled together, as the map does.
  let fallback = new Map<string, GeoEntry | null>();
  if (rows.some((a) => !onlinePlaceOf(a) && storedPlacementOf(a, units).kind === "stale")) {
    await loadGeocodeCache();
    fallback = placeLieux(rows.filter((a) => !onlinePlaceOf(a)).map(placeKeyOf));
  }
  return {
    kind: "ok",
    auditions: rows.map((a) => ({ ...ownFields(a), area: areaOfRow(a, units, fallback) })),
  };
}

async function adminListFromGeocoder(
  client: Client,
): Promise<{ kind: "ok"; auditions: AdminAudition[] } | DbError> {
  const { data: rows, error } = await selectAll((last?: { date: string; id: string }) => {
    const q = client
      .from("auditions")
      .select(ADMIN_LIST_COLUMNS)
      .order("date", { ascending: false })
      .order("id");
    return (last ? q.or(afterByDate(last)) : q).limit(PAGE);
  });
  if (error) return { kind: "dbError", message: error.message };
  await loadGeocodeCache();
  // The lieux the geocoder places, as on the map: not an online audition's
  // whose town hall is stored with it.
  const lieux = rows.filter((a) => !onlinePlaceOf(a)).map(placeKeyOf);
  // Each lieu never geocoded, once, one after the other, in the background.
  const missing = new Set(lieux.filter((c) => getCachedEntry(c) === undefined));
  if (missing.size) {
    void (async () => {
      for (const c of missing) await resolveLocation(c).catch(() => null);
    })();
  }
  // Settled together, as the map does: same-named communes against the rest.
  const placed = placeLieux(lieux);
  const auditions = rows.map((a): AdminAudition => {
    const canonical = placeKeyOf(a);
    const online = onlinePlaceOf(a);
    if (online) {
      return {
        ...ownFields(a),
        area: {
          canonicalName: canonical,
          city: online.commune,
          departementCode: online.departementCode,
          departementName: online.departementName,
          region: online.region,
          placement: "address",
        },
      };
    }
    const entry = placed.get(canonical);
    return {
      ...ownFields(a),
      area: {
        canonicalName: canonical,
        city: entry?.city ?? null,
        departementCode: entry?.depCode ?? null,
        departementName: entry?.depName ?? null,
        region: entry?.region ?? null,
        // A curated point puts it on the map whatever the lookup said, as
        // buildLocationGroups does.
        ...(getKnownCoordinates(canonical)
          ? { placement: "address" }
          : placementOf(getCachedEntry(canonical), entry)),
      },
    };
  });
  return { kind: "ok", auditions };
}

// ---- Writes ---------------------------------------------------------------

/** How long a write waits for its lieu to be placed before it is stored without (the job places it). */
const PLACE_BUDGET_MS = 3000;

/**
 * Where an audition's lieu goes, waited for 3 seconds at most: its units are
 * written, and the placement is for the row's write. Null when it is late (a
 * slow geocoder — the lookup goes on, and its answer is cached for the
 * placement job), or could not be had.
 */
async function placeBriefly(
  location: string,
  pick: PlacePick | undefined,
  log: FastifyBaseLogger,
): Promise<Placement | null> {
  const placement = await Promise.race([
    placeLieu(location, { pick }).catch((e: unknown) => {
      log.warn({ err: e, location }, "placement failed, left to the placement job");
      return null;
    }),
    new Promise<null>((done) => setTimeout(() => done(null), PLACE_BUDGET_MS).unref?.()),
  ]);
  if (!placement || placement === "retry") {
    if (pick) log.warn({ location, pick }, "picked place not stored: the text will place it");
    return null;
  }
  try {
    await upsertGeoUnits(placement.units);
  } catch (e) {
    log.warn({ err: e, location }, "units not written, placement left to the placement job");
    return null;
  }
  return placement;
}

const PLACE_CONSTRAINT = /\bauditions_place_\w+/;
const PLACE_COLUMN =
  /'(place_\w+|locality_id|lieu_key|lat|lng|placed_location|placed_rules|geo_release)'/;

/**
 * Whether the database refused the place, not the audition: one of the place
 * CHECKs or its foreign key (a bug, not the admin's), or no place columns at
 * all (a database the place migration has not reached yet). The write is
 * then made again without the place, the row left stale for the job.
 */
function placeRefused(
  error: { code?: string; message?: string; details?: string | null } | null,
): "constraint" | "schema" | null {
  if (!error) return null;
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (error.code === "23514" || error.code === "23503") {
    return PLACE_CONSTRAINT.test(text) ? "constraint" : null;
  }
  if (error.code === "PGRST204" && PLACE_COLUMN.test(text)) return "schema";
  return null;
}

/** The place refused, logged: an error for a refused constraint, a warning for a database behind. */
function logPlaceRefused(
  log: FastifyBaseLogger,
  why: "constraint" | "schema",
  error: unknown,
  placement: Placement,
): void {
  if (why === "constraint") {
    log.error({ err: error, placement: placement.columns }, "place refused, audition stored stale");
  } else {
    log.warn({ err: error }, "no place columns in this database, audition stored stale");
  }
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

  // Where it goes, stored with it — briefly: a slow geocoder must not hold
  // the creation back. Late, it is stored without, and the placement job
  // places it (nudged below).
  const placement = await placeBriefly(audition.location, input.place, log);
  let { error } = await client
    .from("auditions")
    .insert(placement ? { ...audition, ...placement.columns } : audition);
  const refused = placement ? placeRefused(error) : null;
  if (placement && refused) {
    logPlaceRefused(log, refused, error, placement);
    ({ error } = await client.from("auditions").insert(audition));
  }
  if (error) return { kind: "dbError", message: error.message };

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
  // Once everything is written and placed — not after the audition alone,
  // which only opened a window where it was public with no testimonies. (A
  // read in flight across this write is not stored: lib/cache.ts.)
  invalidatePublicCaches();
  nudgePlacementJob();
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
  // What the audition held: for the audit entry, to tell which fields the
  // save really changed (the form sends them all every time), and for its
  // place. Best effort: a draft is not readable until the policy migration
  // is applied, and the update below does not depend on it. Every column
  // there is: a database without the place columns yet reads all the same.
  const { data: before } = await client.from("auditions").select("*").eq("id", id).maybeSingle();

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

  // Placed again, with the write (see createAudition): when it moved, when an
  // address was picked again, or when it was never placed. Not an online
  // audition: its town hall is its place. A lieu placed abroad keeps its
  // place, but for a new pick: only its name follows the text (A7).
  const where = online ? undefined : (next.location ?? before?.location);
  const moved = next.location !== undefined && next.location !== before?.location;
  const replace =
    where !== undefined && (input.place !== undefined || moved || before?.place_stale === true);
  const abroad =
    replace && !input.place && before ? keepPlacedAbroad({ ...before, location: where }) : null;
  const placement = replace ? (abroad ?? (await placeBriefly(where, input.place, log))) : null;
  // With the location it was computed from, in the same write; for a
  // location the form did not send, only where it is still that one.
  const withPlace = placement && next.location !== undefined ? placement.columns : {};

  // `count` is the number of rows the update touched — known without
  // reading them back, so it works for drafts too.
  let { error, count } = await client
    .from("auditions")
    .update({ ...next, ...withPlace }, { count: "exact" })
    .eq("id", id);
  const refused = placement ? placeRefused(error) : null;
  if (placement && refused) {
    logPlaceRefused(log, refused, error, placement);
    ({ error, count } = await client
      .from("auditions")
      .update(next, { count: "exact" })
      .eq("id", id));
  }
  if (error) return { kind: "dbError", message: error.message };
  if (placement && next.location === undefined && where !== undefined) {
    const { error: perror } = await client
      .from("auditions")
      .update(placement.columns)
      .eq("id", id)
      .eq("location", where);
    if (perror) log.error({ err: perror, audition: id }, "place not stored, left to the job");
  }
  // Right after the write, before anything slow: nothing stale past it.
  invalidatePublicCaches();
  nudgePlacementJob();

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
  // Its testimonies are gone: the counts and the map have moved, whatever
  // the next statement does.
  if (deletedTestimonies) invalidatePublicCaches();

  // Emptied that way, the audition has already gone with its last
  // testimony (the database never leaves one empty): nothing is left for
  // this statement, and the audition is deleted all the same.
  const { error, count } = await client.from("auditions").delete({ count: "exact" }).eq("id", id);
  if (!error) invalidatePublicCaches();
  // The lieux that settle same-named communes may have changed.
  if (!error) nudgePlacementJob();
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
  return { kind: "ok" };
}
