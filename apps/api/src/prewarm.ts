import type { FastifyBaseLogger } from "fastify";
import { cached, cachedResponse } from "./lib/cache";
import { PUBLIC_CACHE_KEYS, PUBLIC_CACHE_TTL_MS } from "./lib/publicCache";
import { fetchPublishedAuditions } from "./modules/auditions/service";
import {
  buildImportedGroups,
  buildImportedTestimonies,
  IMPORTED_CACHE_KEYS,
  IMPORTED_CACHE_TTL_MS,
} from "./modules/imported-auditions/service";
import { buildLocationGroups } from "./modules/map/locationGroups";
import { fetchPublicTestimonies } from "./modules/testimonies/service";

/**
 * Fill the public read caches at boot, so the first visitor after a deploy is
 * served from memory like every other (the corpus alone is a 1.65 s pull) and,
 * from then on, the refills run behind the replies (stale-while-revalidate,
 * lib/cache.ts) rather than in front of an unlucky one. The keys a route sends
 * as bytes get their bytes (JSON, gzip, ETag) built here too. Best effort: a
 * failure is logged and the first request fills that key as before.
 */
export async function prewarmPublicCaches(log: FastifyBaseLogger): Promise<void> {
  const fills: [string, () => Promise<unknown>][] = [
    [
      PUBLIC_CACHE_KEYS.auditions,
      () =>
        cachedResponse(
          PUBLIC_CACHE_KEYS.auditions,
          PUBLIC_CACHE_TTL_MS.auditions,
          fetchPublishedAuditions,
        ),
    ],
    [
      PUBLIC_CACHE_KEYS.testimonies,
      () =>
        cachedResponse(
          PUBLIC_CACHE_KEYS.testimonies,
          PUBLIC_CACHE_TTL_MS.testimonies,
          fetchPublicTestimonies,
        ),
    ],
    // Reads the auditions through the key above: one Supabase pull for both.
    [
      PUBLIC_CACHE_KEYS.map,
      () => cachedResponse(PUBLIC_CACHE_KEYS.map, PUBLIC_CACHE_TTL_MS.map, buildLocationGroups),
    ],
    [
      IMPORTED_CACHE_KEYS.map,
      () => cachedResponse(IMPORTED_CACHE_KEYS.map, IMPORTED_CACHE_TTL_MS, buildImportedGroups),
    ],
    // Filtered per request on its route: the value, not bytes.
    [
      IMPORTED_CACHE_KEYS.testimonies,
      () =>
        cached(IMPORTED_CACHE_KEYS.testimonies, IMPORTED_CACHE_TTL_MS, buildImportedTestimonies),
    ],
  ];
  const results = await Promise.allSettled(fills.map(([, run]) => run()));
  results.forEach((r, i) => {
    if (r.status === "rejected") log.warn({ key: fills[i][0], err: r.reason }, "prewarm failed");
  });
}
