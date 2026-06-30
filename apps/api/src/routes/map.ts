import type { FastifyInstance } from "fastify";
import { buildLocationGroups, warmLocationGeocodes } from "../services/locations";

export default async function mapRoutes(app: FastifyInstance) {
  // Published auditions grouped by canonical location, with coordinates.
  // Returns known + already-geocoded groups immediately, and kicks off
  // background geocoding for the rest (poll again to pick them up).
  app.get("/", async (_req, reply) => {
    try {
      const groups = await buildLocationGroups();
      void warmLocationGeocodes();
      return groups;
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });
}
