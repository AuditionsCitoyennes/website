import type { FastifyInstance } from "fastify";
import { buildLocationGroups, warmLocationGeocodes } from "../services/locations";
import { cached, PUBLIC_CACHE_KEYS } from "../cache";

export default async function mapRoutes(app: FastifyInstance) {
  // Published auditions grouped by canonical location, with coordinates.
  // Returns known + already-geocoded groups immediately, and kicks off
  // background geocoding for the rest (poll again to pick them up).
  //
  // The client polls this every 2.5s until the group count stabilises; a short
  // TTL collapses that burst into one Supabase query while still letting newly
  // geocoded locations surface within a poll or two. The background warm pass
  // runs on every hit (cheap once the geocode cache is populated) so a cold
  // cache keeps making progress regardless of the response cache.
  app.get("/", async (_req, reply) => {
    try {
      const groups = await cached(PUBLIC_CACHE_KEYS.map, 15_000, buildLocationGroups);
      void warmLocationGeocodes();
      return groups;
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });
}
