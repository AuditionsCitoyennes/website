import type { FastifyBaseLogger } from "fastify";
import { hasServiceRole } from "./config";
import { prewarmPlaceReads } from "./modules/places/readRoutes";

/**
 * Fill the place reads every first visit to the map waits on at boot, so the
 * first visitor after a deploy is served from memory like every other and,
 * from then on, the refills run behind the replies (stale-while-revalidate,
 * lib/cache.ts) rather than in front of an unlucky one: the Témoignages
 * map's world with its analyses' figures, and the filter dialog's facets
 * (map phase 1). Best effort: a failure is logged and the first request
 * fills that key as before.
 *
 * Not the whole-table reads (/api/auditions, /api/map, /api/testimonies):
 * the site no longer asks for them (only the testing tools' corpus pipeline
 * does), and each grows with every audition or testimony — a boot that pulls
 * them whole can outgrow the container before it serves anything. Without
 * the service role there are no place reads to fill.
 */
export async function prewarmPublicCaches(log: FastifyBaseLogger): Promise<void> {
  if (!hasServiceRole) return;
  const fills = prewarmPlaceReads();
  const results = await Promise.allSettled(fills.map(([, fill]) => fill));
  results.forEach((r, i) => {
    if (r.status === "rejected") log.warn({ key: fills[i][0], err: r.reason }, "prewarm failed");
  });
}
