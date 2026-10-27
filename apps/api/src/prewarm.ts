import type { FastifyBaseLogger } from "fastify";
import { TooLongError } from "./lib/guards";
import { legacyCache, PUBLIC_CACHE_KEYS, PUBLIC_CACHE_TTL_MS } from "./lib/publicCache";
import { guardedPublishedAuditions } from "./modules/auditions/service";
import { buildLocationGroups } from "./modules/map/locationGroups";

/**
 * Fill the small public read caches at boot, so the first visitor after a
 * deploy is served from memory like every other and, from then on, the
 * refills run behind the replies (stale-while-revalidate, lib/cache.ts)
 * rather than in front of an unlucky one. The keys a route sends as bytes get
 * their bytes (JSON, gzip, ETag) built here too. Best effort: a failure is
 * logged and the first request fills that key as before.
 *
 * Not the testimony corpus (/api/testimonies): it grows with every testimony,
 * and a boot that pulls it whole can outgrow the container before it serves
 * anything. Its first request fills it.
 */
export async function prewarmPublicCaches(log: FastifyBaseLogger): Promise<void> {
  const fills: [string, () => Promise<unknown>][] = [
    [
      PUBLIC_CACHE_KEYS.auditions,
      () =>
        legacyCache.response(PUBLIC_CACHE_KEYS.auditions, guardedPublishedAuditions, {
          ttlMs: PUBLIC_CACHE_TTL_MS.auditions,
        }),
    ],
    // Reads the auditions through the key above: one Supabase pull for both.
    [
      PUBLIC_CACHE_KEYS.map,
      () =>
        legacyCache.response(PUBLIC_CACHE_KEYS.map, () => buildLocationGroups(undefined, log), {
          ttlMs: PUBLIC_CACHE_TTL_MS.map,
        }),
    ],
  ];
  const results = await Promise.allSettled(fills.map(([, run]) => run()));
  results.forEach((r, i) => {
    if (r.status !== "rejected") return;
    // Too large to be served whole (lib/guards.ts): nothing to warm.
    if (r.reason instanceof TooLongError) log.info({ key: fills[i][0] }, "prewarm: refused whole");
    else log.warn({ key: fills[i][0], err: r.reason }, "prewarm failed");
  });
}
