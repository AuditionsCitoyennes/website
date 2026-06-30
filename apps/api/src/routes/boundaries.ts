import type { FastifyInstance } from "fastify";
import { getCommune, getLevel } from "../services/boundaries";

export default async function boundaryRoutes(app: FastifyInstance) {
  // Régions / départements as an enriched FeatureCollection (geometry + centre +
  // bounds per unit). The frontend filters to the children of the current scope.
  app.get<{ Params: { level: string } }>("/:level", async (req, reply) => {
    try {
      return await getLevel(req.params.level);
    } catch (e) {
      return reply.notFound((e as Error).message);
    }
  });

  // A single commune / arrondissement municipal by INSEE code (precise contour).
  app.get<{ Params: { insee: string } }>("/commune/:insee", async (req, reply) => {
    try {
      return await getCommune(req.params.insee);
    } catch (e) {
      return reply.notFound((e as Error).message);
    }
  });
}
