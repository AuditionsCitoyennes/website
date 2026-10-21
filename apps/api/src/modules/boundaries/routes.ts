import type { FastifyInstance } from "fastify";
import { getCommune, getCommunes, getDepartement, getLevel } from "./service";

export default async function boundaryRoutes(app: FastifyInstance) {
  // Every commune currently in view, in ONE request. Registered before the
  // "/:level" catch-all so "communes" isn't swallowed as a level name.
  app.get<{ Querystring: { codes?: string } }>("/communes", async (req, reply) => {
    const codes = (req.query.codes ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (codes.length === 0) return { type: "FeatureCollection", features: [] };
    if (codes.length > 200) return reply.badRequest("too many codes (max 200)");
    try {
      return await getCommunes(codes);
    } catch (e) {
      return reply.internalServerError((e as Error).message);
    }
  });

  // Métropole / régions / départements as an enriched FeatureCollection
  // (geometry + centre + bounds per unit). The frontend filters to the children
  // of the current scope; "metropole" is the single France contour.
  app.get<{ Params: { level: string } }>("/:level", async (req, reply) => {
    try {
      return await getLevel(req.params.level);
    } catch (e) {
      return reply.notFound((e as Error).message);
    }
  });

  // A département as the map raises it: the union of its communes' contours.
  app.get<{ Params: { code: string } }>("/departement/:code", async (req, reply) => {
    try {
      return await getDepartement(req.params.code);
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
