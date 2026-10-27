import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  contentFiltersOf,
  isDay,
  LIEU_ID,
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
  type CacheFamily,
  type CachedResponse,
  type CacheState,
  type FamilyHit,
} from "../../lib/cache";
import {
  DbBusyError,
  DbRefusedError,
  DbTimeoutError,
  isTransientDbError,
  newTiming,
  type DbTiming,
} from "../../lib/dbGate";
import { sendCached, sendJson } from "../../lib/httpCache";
import { lieuCache, placesCache, resultsCache, tpageCache } from "../../lib/publicCache";
import { clientKey, takeHits } from "../../lib/rateLimit";
import { visitorIp } from "../../lib/visitor";
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

const NO_SERVICE_ROLE = "Les lieux ne sont pas disponibles pour le moment.";

/** Misses a visitor may cause, per window; and those with a text. */
const MISS_LIMIT = 30;
const SEARCH_LIMIT = 20;
const LIMIT_WINDOW_MS = 10_000;

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const BUDGET_DEFAULT = 600;

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
  .string()
  .regex(/^\d{1,3}$/, `Limite invalide (1 à ${PAGE_MAX}).`)
  .transform(Number)
  .refine((n) => n >= 1 && n <= PAGE_MAX, `Limite invalide (1 à ${PAGE_MAX}).`)
  .default(PAGE_DEFAULT);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const placeUnit = (u: string) => u === "world" || UNIT_ID.test(u);

const countsQuery = placeFilterQuerySchema
  .extend({
    unit: z.string().refine(placeUnit, "Unité invalide.").optional(),
    units: z
      .string()
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
      .string()
      .regex(/^\d{1,4}$/, "Budget invalide (0 à 2000).")
      .transform(Number)
      .refine((n) => n <= 2000, "Budget invalide (0 à 2000).")
      .optional(),
  })
  .refine((q) => (q.unit === undefined) !== (q.units === undefined), {
    error: "Une unité (unit) ou une liste d'unités (units) attendue.",
  });

const lieuQuery = placeFilterQuerySchema.extend({
  id: z.string({ error: "Lieu requis." }).regex(LIEU_ID, "Lieu invalide."),
  sort,
});

const resultsQuery = placeFilterQuerySchema
  .extend({
    sort,
    limit,
    // The `next` of the page before: date, rank, lieu id, audition id.
    after: z
      .string()
      .transform(list)
      .refine(
        (a) =>
          a.length === 4 && isDay(a[0]) && isDay(a[1]) && LIEU_ID.test(a[2]) && UUID.test(a[3]),
        "Curseur invalide.",
      )
      .optional(),
    through: z.string().regex(UUID, "Audition invalide.").optional(),
  })
  .refine((q) => !(q.after && q.through), { error: "after et through sont exclusifs." });

const contentQuery = placeFilterQuerySchema.pick({ v: true, t: true, q: true });

const testimoniesQuery = contentQuery.extend({
  limit,
  // The `next` of the page before: created_at (empty: none), id.
  after: z
    .string()
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

/** Counts `calls` RPC calls against the visitor's limits, or throws RateLimitedError. */
function charge(req: FastifyRequest, calls: number, search: boolean): void {
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
  const waitMs = takeHits(rules);
  if (waitMs > 0) throw new RateLimitedError(waitMs);
}

/** A read failed: what the visitor is told (anything unmapped is a 500, see server.ts). */
function replyError(req: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  reply.header("Cache-Control", "no-store");
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
  if (err instanceof DbRefusedError) {
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

/** `res` with `"textIgnored": true` first, for this reply alone. */
function withTextIgnored(res: CachedResponse): { json: Buffer; etag: string } {
  const head = Buffer.from(res.json.length > 2 ? '{"textIgnored":true,' : '{"textIgnored":true');
  return {
    json: Buffer.concat([head, res.json.subarray(1)]),
    etag: combinedEtag([res.etag, "textIgnored"]),
  };
}

/** One cached answer, as is (or with textIgnored). */
function sendOne(
  req: FastifyRequest,
  reply: FastifyReply,
  res: CachedResponse,
  f: PlaceFilters,
): Promise<FastifyReply> | FastifyReply {
  if (f.textIgnored) return sendJson(req, reply, withTextIgnored(res), "no-cache");
  return sendCached(req, reply, res, "no-cache");
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
        beforeFill: (calls) => charge(req, calls, f.needle !== ""),
        transient: isTransientDbError,
      });
      timed(reply, hit.state, timing, performance.now() - started);
      return sendOne(req, reply, hit.res, f);
    }
    charge(req, 1, f.needle !== "");
    const res = await buildResponse(await read.fetch(timing));
    timed(reply, "miss", timing, performance.now() - started);
    return sendOne(req, reply, res, f);
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
    const asked = q.unit !== undefined ? [q.unit] : q.units!;
    const units = [...new Set(asked)];
    const keyOf = (unit: string) =>
      `places|${unit}|d${args.depth}|x${Number(args.facts)}|e${Number(empty)}|b${args.budget}|${fkey}`;
    const unitOfKey = new Map(units.map((u) => [keyOf(u), u]));

    const timing = newTiming();
    const started = performance.now();
    let hits: FamilyHit[];
    try {
      hits = await placesCache.getMany(
        units.map(keyOf),
        (keys) =>
          placeCountsMany(
            keys.map((k) => unitOfKey.get(k)!),
            args,
            timing,
          ),
        {
          chunk: UNITS_PER_CALL,
          beforeFill: (calls) => charge(req, calls, f.needle !== ""),
          transient: isTransientDbError,
        },
      );
    } catch (err) {
      timed(reply, "miss", timing, performance.now() - started);
      return replyError(req, reply, err);
    }
    timed(reply, stateOf(hits), timing, performance.now() - started);

    if (q.unit !== undefined) return sendOne(req, reply, hits[0].res, f);
    // {results: [...]} from the per-unit bytes, in the order asked.
    const byUnit = new Map(units.map((u, i) => [u, hits[i].res]));
    const parts = asked.map((u) => byUnit.get(u)!);
    const json = Buffer.concat([
      Buffer.from(f.textIgnored ? '{"textIgnored":true,"results":[' : '{"results":['),
      ...parts.flatMap((p, i) => (i === 0 ? [p.json] : [COMMA, p.json])),
      Buffer.from("]}"),
    ]);
    const etag = combinedEtag([
      f.textIgnored ? "batch+textIgnored" : "batch",
      ...parts.map((p) => p.etag),
    ]);
    return sendJson(req, reply, { json, etag }, "no-cache");
  });

  // A lieu's matching auditions (the lazy path's open lieu).
  app.get("/api/places/lieu", async (req, reply) => {
    if (!hasServiceRole) return reply.serviceUnavailable(NO_SERVICE_ROLE);
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
    return serveRead(req, reply, placeFiltersOf({}), {
      family: placesCache,
      key: "facets",
      fetch: (timing) => placeFacets(timing),
    });
  });

  // An opened audition's testimonies matching the content filters, oldest
  // first, keyset pages (the first cached).
  app.get<{ Params: { id: string } }>("/api/auditions/:id/testimonies", async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.notFound("Audition introuvable");
    if (!hasServiceRole) return reply.serviceUnavailable(NO_SERVICE_ROLE);
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
