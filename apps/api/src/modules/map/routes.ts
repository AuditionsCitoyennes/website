import type { FastifyInstance } from "fastify";
import { buildLocationGroups, warmLocationGeocodes } from "./locationGroups";
import { cachedResponse } from "../../lib/cache";
import { sendCached } from "../../lib/httpCache";
import { PUBLIC_CACHE_KEYS, PUBLIC_CACHE_TTL_MS } from "../../lib/publicCache";

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
  //
  // `no-cache`: the client compares the group count across polls, so a copy it
  // served itself would freeze it. It asks every time, and is told "unchanged"
  // (304, no body) until the groups move.
  app.get("/", async (req, reply) => {
    try {
      const res = await cachedResponse(
        PUBLIC_CACHE_KEYS.map,
        PUBLIC_CACHE_TTL_MS.map,
        buildLocationGroups,
      );
      void warmLocationGeocodes();
      return sendCached(req, reply, res, "no-cache");
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });
}
