import type { FastifyInstance } from "fastify";
import { buildImportedGroups, buildImportedTestimonies } from "../services/importedAuditions";
import { cached } from "../cache";

export default async function importedAuditionRoutes(app: FastifyInstance) {
  // Imported events grouped for the map, same shape as /api/map — pins + drill
  // metadata only, no report text. The import set is immutable and pre-baked, so
  // a long TTL keeps this off the hot path.
  app.get("/map", async (_req, reply) => {
    try {
      return await cached("imported:map", 300_000, buildImportedGroups);
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
      const all = await cached("imported:testimonies", 300_000, buildImportedTestimonies);
      return all.filter((t) =>
        audition ? t.audition?.id === audition : t.audition?.location === place,
      );
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });
}
