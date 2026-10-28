import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  contentFiltersOf,
  isDay,
  LIEU_ID,
  oneParam,
  PLACE_IDS_MAX,
  PLACE_SORTS,
  placeFilterKey,
  placeFilterQuerySchema,
  placeFiltersOf,
  rpcPlaceFilters,
  UNIT_ID,
  type PlaceFilters,
} from "@ac/shared";
import { config, hasServiceRole, rateLimitFactor } from "../../config";
import { requireAdmin, getRoles } from "../../lib/auth";
import {
  buildResponse,
  combinedEtag,
  KeyFailure,
  Prebuilt,
  responseOf,
  type CacheFamily,
  type CachedResponse,
  type CacheState,
  type FamilyHit,
} from "../../lib/cache";
import {
  DbBusyError,
  DbGate,
  DbRefusedError,
  DbTimeoutError,
  DbTooLargeError,
  DbUnavailableError,
  isTransientDbError,
  newTiming,
  type DbTiming,
} from "../../lib/dbGate";
import { sendCached, sendNotModified } from "../../lib/httpCache";
import {
  assembledCache,
  lieuCache,
  placesCache,
  resultsCache,
  tpageCache,
} from "../../lib/publicCache";
import { clientKey, forceHits, refundHits, takeHits, type HitRule } from "../../lib/rateLimit";
import { visitorIp } from "../../lib/visitor";
import { nudgePlacementJobFromRead } from "./placementJob";
import {
  adminAuditionFilter,
  auditionResults,
  lieuAuditions,
  placeCountsMany,
  placeFacets,
  testimonyPage,
  UNITS_PER_CALL,
  type CountsArgs,
} from "./read";

// The place reads of the Témoignages map (map phase 1, design D1): counts
// per unit, a lieu's auditions, the result list, the filter dialog's facets,
// an audition's testimonies, and the admin list's content filters. Each is a
// read RPC through the service role (never anon: without the key, 503), its
// answer cached per key in a byte-bounded family (lib/publicCache.ts) and
// sent as is: pre-gzipped, with an ETag, `no-cache` (a client revalidates and
// is told 304 until a write). Cache misses cost the visitor: 30 RPC calls per
// 10 s, 20 of them with a text (429 with Retry-After past that); every call
// goes through the database gate (lib/dbGate.ts).
//
// A response assembled from cached answers (a units= batch, an answer with
// "textIgnored") is kept too, in a family of its own (assembledCache: it
// never evicts the answers it is made of), under its ETag — the hash of its
// parts' tags, so it is exactly the bytes those parts make — and built once,
// through a gate of its own; a visitor's request that builds one without
// reaching the database pays one call for it, and nothing when the gate
// refuses it. A hit, and a 304, build nothing.
//
// Each read nudges the placement job (at most once a minute, as /api/map
// does): a row the old app wrote is placed, and shows here, within about a
// minute while the site is being read.

const NO_SERVICE_ROLE = "Les lieux ne sont pas disponibles pour le moment.";

/** Misses a visitor may cause, per window; and those with a text. */
const MISS_LIMIT = 30;
const SEARCH_LIMIT = 20;
const LIMIT_WINDOW_MS = 10_000;

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const BUDGET_DEFAULT = 600;

/**
 * The heaviest units= answer assembled (the sum of its units' JSON): a hit
 * costs no limit, so without it one large cached unit asked 50 times was a
 * 50-fold body built and gzipped on every request. The web's heaviest batch
 * (the scope's chain under a filter) stays well below.
 */
export const BATCH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Assemblies at once (each up to BATCH_MAX_BYTES of JSON and its gzip), the
 * rest waiting their turn a while, then 503: the Buffers they make are
 * outside the heap, and nothing else bounds them. (Exported for the tests.)
 */
export const assemblyGate = new DbGate({
  max: 4,
  queue: 50,
  waitMs: 5000,
  timeoutMs: 60_000,
  holdMs: 0,
});

// ---- Query parameters ------------------------------------------------------------

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const flag = z
  .enum(["0", "1", "true", "false"], { error: "Drapeau invalide (0 ou 1)." })
  .transform((v) => v === "1" || v === "true");

const sort = z.enum(PLACE_SORTS, { error: "Tri invalide (recent ou ancien)." }).default("recent");

const limit = z
  .string(oneParam("limit"))
  .regex(/^\d{1,3}$/, `Limite invalide (1 à ${PAGE_MAX}).`)
  .transform(Number)
  .refine((n) => n >= 1 && n <= PAGE_MAX, `Limite invalide (1 à ${PAGE_MAX}).`)
  .default(PAGE_DEFAULT);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const placeUnit = (u: string) => u === "world" || UNIT_ID.test(u);

const countsQuery = placeFilterQuerySchema
  .extend({
    unit: z.string(oneParam("unit")).refine(placeUnit, "Unité invalide.").optional(),
    units: z
      .string(oneParam("units"))
      .transform(list)
      .refine((us) => us.length >= 1 && us.length <= PLACE_IDS_MAX, {
        error: `De 1 à ${PLACE_IDS_MAX} unités.`,
      })
      .refine((us) => us.every(placeUnit), "Unité invalide.")
      .optional(),
    depth: z.enum(["1", "2", "3"], { error: "Profondeur invalide (1 à 3)." }).optional(),
    facts: flag.optional(),
    empty: flag.optional(),
    budget: z
      .string(oneParam("budget"))
      .regex(/^\d{1,4}$/, "Budget invalide (0 à 2000).")
      .transform(Number)
      .refine((n) => n <= 2000, "Budget invalide (0 à 2000).")
      .optional(),
  })
  .refine((q) => (q.unit === undefined) !== (q.units === undefined), {
    error: "Une unité (unit) ou une liste d'unités (units) attendue.",
  });

const lieuQuery = placeFilterQuerySchema.extend({
  id: z
    .string({
      error: (issue) => (issue.input === undefined ? "Lieu requis." : oneParam("id").error),
    })
    .regex(LIEU_ID, "Lieu invalide."),
  sort,
});

const resultsQuery = placeFilterQuerySchema
  .extend({
    sort,
    limit,
    // The `next` of the page before, as audition_results gives it: date,
    // rank, tie (the id of its lieu's newest audition), audition id.
    after: z
      .string(oneParam("after"))
      .transform(list)
      .refine(
        (a) => a.length === 4 && isDay(a[0]) && isDay(a[1]) && UUID.test(a[2]) && UUID.test(a[3]),
        "Curseur invalide.",
      )
      .optional(),
    through: z.string(oneParam("through")).regex(UUID, "Audition invalide.").optional(),
  })
  .refine((q) => !(q.after && q.through), { error: "after et through sont exclusifs." });

const contentQuery = placeFilterQuerySchema.pick({ v: true, t: true, q: true });

const testimoniesQuery = contentQuery.extend({
  limit,
  // The `next` of the page before: created_at (empty: none), id.
  after: z
    .string(oneParam("after"))
    .refine((s) => {
      const parts = s.split(",");
      return (
        parts.length === 2 &&
        (parts[0] === "" || !Number.isNaN(Date.parse(parts[0]))) &&
        UUID.test(parts[1])
      );
    }, "Curseur invalide.")
    .transform((s) => {
      const [at, id] = s.split(",");
      return [at === "" ? null : at, id];
    })
    .optional(),
});

// ---- Cache keys --------------------------------------------------------------------

/** A unit's answer in placesCache: its unit, how it was asked, its filter key. */
function countsKey(unit: string, args: CountsArgs, fkey: string): string {
  return `places|${unit}|d${args.depth}|x${Number(args.facts)}|e${Number(args.empty)}|b${args.budget}|${fkey}`;
}

/** The filter dialog's facets in placesCache. */
const FACETS_KEY = "facets";

/** zod's first complaint, in the visitor's words. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Requête invalide.";
}

// ---- Limits, errors, timing ------------------------------------------------------

/** Past a visitor's miss or search limit: 429 with Retry-After. */
export class RateLimitedError extends Error {
  readonly statusCode = 429;
  constructor(readonly waitMs: number) {
    super("Trop de requêtes. Réessayez dans un instant.");
    this.name = "RateLimitedError";
  }
}

/** The visitor's limits that `calls` RPC calls count against. */
function limitsOf(req: FastifyRequest, calls: number, search: boolean): HitRule[] {
  const who = clientKey(visitorIp(req));
  const rules = [
    {
      key: `${who}:places-miss`,
      n: calls,
      max: MISS_LIMIT * rateLimitFactor,
      windowMs: LIMIT_WINDOW_MS,
    },
  ];
  if (search) {
    rules.push({
      key: `${who}:search`,
      n: calls,
      max: SEARCH_LIMIT * rateLimitFactor,
      windowMs: LIMIT_WINDOW_MS,
    });
  }
  return rules;
}

/**
 * Counts `calls` RPC calls against the visitor's limits, or throws
 * RateLimitedError; returns how to give them back (work that never ran).
 */
function charge(req: FastifyRequest, calls: number, search: boolean): () => void {
  const rules = limitsOf(req, calls, search);
  const waitMs = takeHits(rules);
  if (waitMs > 0) throw new RateLimitedError(waitMs);
  const takenAt = Date.now();
  return () => refundHits(rules, takenAt);
}

/** Counts calls already under way (a split batch): never refused, paid from the next request on. */
function chargeAfter(req: FastifyRequest, calls: number, search: boolean): void {
  forceHits(limitsOf(req, calls, search));
}

/** A read failed: what the visitor is told (anything unmapped is a 500, see server.ts). */
function replyError(req: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  reply.header("Cache-Control", "no-store");
  // Set when the body was about to be built (sendDerived): not the error's.
  reply.removeHeader("ETag");
  if (err instanceof RateLimitedError) {
    reply.header("Retry-After", String(Math.max(1, Math.ceil(err.waitMs / 1000))));
    return reply.tooManyRequests(err.message);
  }
  if (err instanceof DbBusyError) {
    reply.header("Retry-After", "1");
    return reply.serviceUnavailable(err.message);
  }
  if (err instanceof DbTimeoutError) {
    req.log.warn({ detail: err.detail, route: req.routeOptions.url }, "place read timed out");
    return reply.serviceUnavailable(err.message);
  }
  if (err instanceof DbUnavailableError) {
    req.log.warn(
      { detail: err.detail, route: req.routeOptions.url },
      "place read: database unavailable",
    );
    reply.header("Retry-After", "5");
    return reply.serviceUnavailable(err.message);
  }
  if (err instanceof DbRefusedError || err instanceof DbTooLargeError) {
    req.log.warn({ detail: err.detail, route: req.routeOptions.url }, "place read refused");
    return reply.badRequest(err.message);
  }
  throw err;
}

/** The worst of several states: one miss makes a miss. */
function stateOf(hits: readonly FamilyHit[]): CacheState {
  if (hits.some((h) => h.state === "miss")) return "miss";
  if (hits.some((h) => h.state === "stale")) return "stale";
  return "hit";
}

/** X-Cache and Server-Timing (cache state, wait for a gate slot, time in the database). */
function timed(reply: FastifyReply, state: CacheState, timing: DbTiming, waitedMs: number): void {
  const db = state === "hit" ? 0 : Math.max(0, waitedMs - timing.gateMs);
  reply.header("X-Cache", state);
  reply.header(
    "Server-Timing",
    `cache;desc=${state}, gate;dur=${timing.gateMs.toFixed(1)}, db;dur=${db.toFixed(1)}`,
  );
}

/**
 * A response assembled from cached parts, tagged `etag` (theirs, combined):
 * a 304 when the client holds it, before anything is built; else kept in
 * assembledCache under that tag and built once, through the assembly gate,
 * and its bytes sent as they are kept. A request that reached no database
 * pays one call for an assembly it starts: taken before (all or none, as
 * any miss), given back when the gate refuses the assembly — a visitor
 * turned away by the gate is charged nothing.
 */
async function sendDerived(
  req: FastifyRequest,
  reply: FastifyReply,
  etag: string,
  build: () => Buffer,
  timing: DbTiming,
): Promise<FastifyReply> {
  const held = sendNotModified(req, reply, etag, "no-cache");
  if (held) return held;
  let refund: (() => void) | undefined;
  const hit = await assembledCache.get(
    `derived|${etag}`,
    async () => {
      try {
        return new Prebuilt(await assemblyGate.run(() => responseOf(build(), etag)));
      } catch (err) {
        if (err instanceof DbBusyError) refund?.();
        throw err;
      }
    },
    {
      beforeFill: (calls) => {
        if (timing.calls === 0) refund = charge(req, calls, false);
      },
      transient: isTransientDbError,
    },
  );
  return sendCached(req, reply, hit.res, "no-cache");
}

/** What an answer whose text was ignored starts with: said so, and the
 *  shortest text searched (the web's hint, learnt in one answer). */
const ignoredHead = () => `"textIgnored":true,"minChars":${config.SEARCH_MIN_CHARS}`;

/** One cached answer, as is (or with `"textIgnored": true` first, kept as its own response). */
function sendOne(
  req: FastifyRequest,
  reply: FastifyReply,
  res: CachedResponse,
  f: PlaceFilters,
  timing: DbTiming,
): Promise<FastifyReply> | FastifyReply {
  if (!f.textIgnored) return sendCached(req, reply, res, "no-cache");
  const head = Buffer.from(res.json.length > 2 ? `{${ignoredHead()},` : `{${ignoredHead()}`);
  return sendDerived(
    req,
    reply,
    combinedEtag([res.etag, "textIgnored"]),
    () => Buffer.concat([head, res.json.subarray(1)]),
    timing,
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * place_counts_many for `units`. A call whose answer is heavier than a read
 * may bring back is made again unit by unit (the extra calls charged to the
 * visitor whose miss it was, after the fact): a unit is refused for its own
 * answer alone, never for the company it was fetched in — what a units=
 * request gets does not depend on which of its units were cached already.
 */
async function countsSplitting(
  units: string[],
  args: CountsArgs,
  timing: DbTiming,
  chargeExtra: (calls: number) => void,
): Promise<unknown[]> {
  try {
    return await placeCountsMany(units, args, timing);
  } catch (err) {
    if (!(err instanceof DbTooLargeError) || units.length === 1) throw err;
    chargeExtra(units.length);
    const alone = await Promise.allSettled(
      units.map(async (u) => (await placeCountsMany([u], args, timing))[0]),
    );
    return alone.map((r) => (r.status === "fulfilled" ? r.value : new KeyFailure(r.reason)));
  }
}

interface CachedRead {
  family: CacheFamily;
  key: string;
  fetch: (timing: DbTiming) => Promise<unknown>;
}

/**
 * One read: from its family when it has a key (a first page, a lieu…), else
 * straight through (later pages), charged to the visitor when it reaches
 * the database.
 */
async function serveRead(
  req: FastifyRequest,
  reply: FastifyReply,
  f: PlaceFilters,
  read: CachedRead | { fetch: (timing: DbTiming) => Promise<unknown> },
): Promise<FastifyReply> {
  const timing = newTiming();
  const started = performance.now();
  try {
    if ("family" in read) {
      const hit = await read.family.get(read.key, () => read.fetch(timing), {
        beforeFill: (calls) => void charge(req, calls, f.needle !== ""),
        transient: isTransientDbError,
      });
      timed(reply, hit.state, timing, performance.now() - started);
      return await sendOne(req, reply, hit.res, f, timing);
    }
    charge(req, 1, f.needle !== "");
    const value = await read.fetch(timing);
    // Built for this reply alone (a later page), its textIgnored with it.
    const res = await buildResponse(
      f.textIgnored && isRecord(value)
        ? { textIgnored: true, minChars: config.SEARCH_MIN_CHARS, ...value }
        : value,
    );
    timed(reply, "miss", timing, performance.now() - started);
    return sendCached(req, reply, res, "no-cache");
  } catch (err) {
    timed(reply, "miss", timing, performance.now() - started);
    return replyError(req, reply, err);
  }
}

// ---- Routes ----------------------------------------------------------------------

export default async function placeReadRoutes(app: FastifyInstance) {
  // Units' subtrees: `unit` (one PlaceCounts) or `units` (up to 50, as
  // {results}). Cached per unit; a request's misses are fetched together,
  // 20 units a call.
  app.get("/api/places", async (req, reply) => {
    if (!hasServiceRole) return reply.serviceUnavailable(NO_SERVICE_ROLE);
    nudgePlacementJobFromRead();
    const parsed = countsQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(firstIssue(parsed.error));
    const q = parsed.data;
    const f = placeFiltersOf(q, config.SEARCH_MIN_CHARS);
    const fkey = placeFilterKey(f);
    const empty = q.empty ?? false;
    if (empty && fkey) return reply.badRequest("empty=1 ne se combine avec aucun filtre.");
    const args: CountsArgs = {
      depth: Number(q.depth ?? 2),
      facts: q.facts ?? false,
      empty,
      // Testing tools only (budget=0: the lazy path at any size).
      budget: config.TEST_TOOLS && q.budget !== undefined ? q.budget : BUDGET_DEFAULT,
      filters: rpcPlaceFilters(f),
    };
    // Each unit once, in the order first asked (the answers carry their unit).
    const units = q.unit !== undefined ? [q.unit] : [...new Set(q.units)];
    const keyOf = (unit: string) => countsKey(unit, args, fkey);
    const unitOfKey = new Map(units.map((u) => [keyOf(u), u]));

    const timing = newTiming();
    const started = performance.now();
    const search = f.needle !== "";
    let hits: FamilyHit[];
    try {
      hits = await placesCache.getMany(
        units.map(keyOf),
        (keys, { refill }) =>
          countsSplitting(
            keys.map((k) => unitOfKey.get(k)!),
            args,
            timing,
            // A refill behind a stale reply is the cache's upkeep: never charged.
            (calls) => (refill ? undefined : chargeAfter(req, calls, search)),
          ),
        {
          chunk: UNITS_PER_CALL,
          beforeFill: (calls) => void charge(req, calls, search),
          transient: isTransientDbError,
        },
      );
    } catch (err) {
      timed(reply, "miss", timing, performance.now() - started);
      return replyError(req, reply, err);
    }
    timed(reply, stateOf(hits), timing, performance.now() - started);

    try {
      if (q.unit !== undefined) {
        return await sendOne(req, reply, hits[0].res, f, timing);
      }
      // {results: [...]} from the per-unit bytes, in the order asked: the same
      // limit cold or warm (each unit's answer is at most a read's, whatever
      // call brought it — see countsSplitting). The order is the body's (and
      // so the ETag's): each order asked is its own assembly.
      const parts = hits.map((h) => h.res);
      if (parts.reduce((n, p) => n + p.json.length, 0) > BATCH_MAX_BYTES) {
        reply.header("Cache-Control", "no-store");
        return reply.badRequest("Réponse trop volumineuse : demandez moins d'unités à la fois.");
      }
      const etag = combinedEtag([
        f.textIgnored ? "batch+textIgnored" : "batch",
        ...parts.map((p) => p.etag),
      ]);
      const build = () =>
        Buffer.concat([
          Buffer.from(f.textIgnored ? `{${ignoredHead()},"results":[` : '{"results":['),
          ...parts.flatMap((p, i) => (i === 0 ? [p.json] : [COMMA, p.json])),
          Buffer.from("]}"),
        ]);
      return await sendDerived(req, reply, etag, build, timing);
    } catch (err) {
      return replyError(req, reply, err);
    }
  });

  // A lieu's matching auditions (the lazy path's open lieu).
  app.get("/api/places/lieu", async (req, reply) => {
    if (!hasServiceRole) return reply.serviceUnavailable(NO_SERVICE_ROLE);
    nudgePlacementJobFromRead();
    const parsed = lieuQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(firstIssue(parsed.error));
    const q = parsed.data;
    const f = placeFiltersOf(q, config.SEARCH_MIN_CHARS);
    return serveRead(req, reply, f, {
      family: lieuCache,
      key: `lieu|${q.id}|${q.sort}|${placeFilterKey(f)}`,
      fetch: (timing) => lieuAuditions(q.id, rpcPlaceFilters(f), q.sort, timing),
    });
  });

  // The matching placed auditions, keyset pages; the first (cached) with the
  // total and the frame. No filter at all is a list too.
  app.get("/api/places/results", async (req, reply) => {
    if (!hasServiceRole) return reply.serviceUnavailable(NO_SERVICE_ROLE);
    nudgePlacementJobFromRead();
    const parsed = resultsQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(firstIssue(parsed.error));
    const q = parsed.data;
    const f = placeFiltersOf(q, config.SEARCH_MIN_CHARS);
    const fetch = (timing: DbTiming) =>
      auditionResults(
        {
          filters: rpcPlaceFilters(f),
          sort: q.sort,
          after: q.after ?? null,
          limit: q.limit,
          through: q.through ?? null,
        },
        timing,
      );
    if (q.after || q.through) return serveRead(req, reply, f, { fetch });
    return serveRead(req, reply, f, {
      family: resultsCache,
      key: `results|${q.sort}|n${q.limit}|${placeFilterKey(f)}`,
      fetch,
    });
  });

  // The filter dialog's themes and date bounds, unfiltered.
  app.get("/api/places/facets", async (req, reply) => {
    if (!hasServiceRole) return reply.serviceUnavailable(NO_SERVICE_ROLE);
    nudgePlacementJobFromRead();
    return serveRead(req, reply, placeFiltersOf({}), {
      family: placesCache,
      key: FACETS_KEY,
      fetch: (timing) => placeFacets(timing),
    });
  });

  // An opened audition's testimonies matching the content filters, oldest
  // first, keyset pages (the first cached).
  app.get<{ Params: { id: string } }>("/api/auditions/:id/testimonies", async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.notFound("Audition introuvable");
    if (!hasServiceRole) return reply.serviceUnavailable(NO_SERVICE_ROLE);
    nudgePlacementJobFromRead();
    const parsed = testimoniesQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(firstIssue(parsed.error));
    const q = parsed.data;
    const f = contentFiltersOf(placeFiltersOf(q, config.SEARCH_MIN_CHARS));
    const id = req.params.id.toLowerCase();
    const fetch = (timing: DbTiming) =>
      testimonyPage(
        { audition: id, filters: rpcPlaceFilters(f), after: q.after ?? null, limit: q.limit },
        timing,
      );
    if (q.after) return serveRead(req, reply, f, { fetch });
    return serveRead(req, reply, f, {
      family: tpageCache,
      key: `tpage|${id}|n${q.limit}|${placeFilterKey(f)}`,
      fetch,
    });
  });

  // The admin list's content filters, per audition (design A22): never
  // cached, never charged (admins only); through the gate like the rest.
  app.get("/api/auditions/admin/filter", { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    if (!hasServiceRole) return reply.serviceUnavailable(NO_SERVICE_ROLE);
    const parsed = contentQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(firstIssue(parsed.error));
    // Today's admin search: any text, however short.
    const f = placeFiltersOf(parsed.data, 1);
    const { isSuperAdmin } = await getRoles(req);
    const timing = newTiming();
    const started = performance.now();
    try {
      const data = await adminAuditionFilter(
        rpcPlaceFilters(f),
        isSuperAdmin ? null : req.user.id,
        timing,
      );
      timed(reply, "miss", timing, performance.now() - started);
      reply.header("Cache-Control", "no-store");
      return data;
    } catch (err) {
      timed(reply, "miss", timing, performance.now() - started);
      return replyError(req, reply, err);
    }
  });
}

const COMMA = Buffer.from(",");

/** What the Témoignages map asks first, unfiltered: the world two levels
 *  down, with every unit's analyses figures (useUnitTree). */
const ROOT_COUNTS: CountsArgs = {
  depth: 2,
  facts: true,
  empty: false,
  budget: BUDGET_DEFAULT,
  filters: {},
};

/** What the home page's card asks first: every audition on the map, those
 *  without testimonies too (empty=1), no figures. */
const CARD_COUNTS: CountsArgs = { ...ROOT_COUNTS, facts: false, empty: true };

/**
 * The place reads every first visit to the map waits on, filled at boot
 * (prewarm.ts) under the very keys the routes read: the world with its
 * figures (/api/places?unit=world&depth=2&facts=1), the facets, and the home
 * card's world (/api/places?unit=world&depth=2&empty=1). Charged to no
 * visitor. Resolves (or rejects) per read, in that order.
 */
export function prewarmPlaceReads(): [string, Promise<unknown>][] {
  const opts = { transient: isTransientDbError };
  const world = (args: CountsArgs): [string, Promise<unknown>] => {
    const key = countsKey("world", args, "");
    return [
      key,
      placesCache.get(key, async () => (await placeCountsMany(["world"], args))[0], opts),
    ];
  };
  return [
    world(ROOT_COUNTS),
    [FACETS_KEY, placesCache.get(FACETS_KEY, () => placeFacets(), opts)],
    world(CARD_COUNTS),
  ];
}
