import type { FastifyInstance } from "fastify";
import {
  buildImportedGroups,
  buildImportedTestimonies,
  IMPORTED_CACHE_KEYS,
  IMPORTED_CACHE_TTL_MS,
} from "./service";
import { cached, cachedResponse } from "../../lib/cache";
import { sendCached } from "../../lib/httpCache";

export default async function importedAuditionRoutes(app: FastifyInstance) {
  // Imported events grouped for the map, same shape as /api/map — pins + drill
  // metadata only, no report text. The import set is immutable and pre-baked, so
  // a long TTL keeps this off the hot path.
  //
  // Pre-baked and immutable, so the bytes are built once per fill and a browser
  // may keep them 5 minutes without asking (no admin write can move them).
  app.get("/map", async (req, reply) => {
    try {
      const res = await cachedResponse(
        IMPORTED_CACHE_KEYS.map,
        IMPORTED_CACHE_TTL_MS,
        buildImportedGroups,
      );
      return sendCached(req, reply, res, "public, max-age=300");
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });

  // Report text, as PublicTestimony, for the panel: ONE audition's (`audition`,
  // its id — what the panel asks for when an audition is opened), or one
  // place's (`place`, the canonical place name — kept for older clients).
  //
  // One of the two is REQUIRED: the full corpus is ~3 MB and must never leave
  // the server in one response. The whole set is cached in memory and filtered
  // here, so a lookup costs one Supabase read per TTL, not one per request.
  app.get("/testimonies", async (req, reply) => {
    // Strings only: a key given twice arrives as an array — not a crash (500),
    // just as good as missing (400).
    const query = req.query as Record<string, unknown>;
    const audition = typeof query.audition === "string" ? query.audition.trim() : undefined;
    const place = typeof query.place === "string" ? query.place.trim() : undefined;
    if (!audition && !place) {
      return reply.badRequest(
        "query param `audition` (an imported audition's id) or `place` (the canonical place name) is required",
      );
    }
    try {
      const all = await cached(
        IMPORTED_CACHE_KEYS.testimonies,
        IMPORTED_CACHE_TTL_MS,
        buildImportedTestimonies,
      );
      return all.filter((t) =>
        audition ? t.audition?.id === audition : t.audition?.location === place,
      );
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });
}
