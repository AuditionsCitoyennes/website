import type { FastifyInstance } from "fastify";
import { mapSource } from "../../config";
import { buildLocationGroups, requestedSource, warmLocationGeocodes } from "./locationGroups";
import { cachedResponse } from "../../lib/cache";
import { sendCached } from "../../lib/httpCache";
import { PUBLIC_CACHE_KEYS, PUBLIC_CACHE_TTL_MS } from "../../lib/publicCache";

export default async function mapRoutes(app: FastifyInstance) {
  // Published auditions grouped by lieu, with coordinates: from the places
  // stored on the rows (MAP_SOURCE=db), or — before map phase 1, and without
  // the service role — from the geocode cache, whose background warm pass a
  // hit kicks off for the lieux not geocoded yet (poll again to pick them up).
  //
  // The client polls this every 2.5s until the group count stabilises; a short
  // TTL collapses that burst into one Supabase query while still letting newly
  // placed lieux surface within a poll or two.
  //
  // `no-cache`: the client compares the group count across polls, so a copy it
  // served itself would freeze it. It asks every time, and is told "unchanged"
  // (304, no body) until the groups move.
  app.get<{ Querystring: { source?: string } }>("/", async (req, reply) => {
    const source = requestedSource(req.query);
    const key = source === mapSource ? PUBLIC_CACHE_KEYS.map : PUBLIC_CACHE_KEYS.mapGeocoder;
    const res = await cachedResponse(key, PUBLIC_CACHE_TTL_MS.map, () =>
      buildLocationGroups(source, req.log),
    );
    if (source === "geocoder") void warmLocationGeocodes();
    return sendCached(req, reply, res, "no-cache");
  });
}
