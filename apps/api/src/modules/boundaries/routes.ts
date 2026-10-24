import type { FastifyInstance } from "fastify";
import { cachedResponse } from "../../lib/cache";
import { sendCached } from "../../lib/httpCache";
import { getCommune, getCommunes, getDepartement, getLevel, UpstreamNotFound } from "./service";

// What /:level accepts; anything else is a 404 before the service is asked.
const LEVELS = new Set(["metropole", "regions", "departements"]);
// A département code: 01-95, 2A/2B, 971-976. Anything else is a 404 — an
// upstream that fails for a real code is a 500 (it used to pass for a 404).
const DEP_CODE = /^(0[1-9]|[1-8]\d|9[0-5]|2[AB]|97[1-6])$/;

// The levels and the raised départements are static open data: serialised and
// gzipped once (the départements level is 585 KB of JSON — 16 ms of gzip on
// every page load before), and a browser may keep them a day without asking.
const STATIC_TTL_MS = 24 * 60 * 60 * 1000;
const STATIC = "public, max-age=86400";

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
    return getCommunes(codes);
  });

  // Métropole / régions / départements as an enriched FeatureCollection
  // (geometry + centre + bounds per unit). The frontend filters to the children
  // of the current scope; "metropole" is the single France contour.
  app.get<{ Params: { level: string } }>("/:level", async (req, reply) => {
    const { level } = req.params;
    if (!LEVELS.has(level)) return reply.notFound(`unknown boundary level: ${level}`);
    const res = await cachedResponse(`boundaries:level:${level}`, STATIC_TTL_MS, () =>
      getLevel(level),
    );
    return sendCached(req, reply, res, STATIC);
  });

  // A département as the map raises it: the union of its communes' contours.
  app.get<{ Params: { code: string } }>("/departement/:code", async (req, reply) => {
    const { code } = req.params;
    if (!DEP_CODE.test(code)) return reply.notFound(`unknown département: ${code}`);
    const res = await cachedResponse(`boundaries:departement:${code}`, STATIC_TTL_MS, () =>
      getDepartement(code),
    );
    return sendCached(req, reply, res, STATIC);
  });

  // A single commune / arrondissement municipal by INSEE code (precise contour).
  app.get<{ Params: { insee: string } }>("/commune/:insee", async (req, reply) => {
    try {
      return await getCommune(req.params.insee);
    } catch (e) {
      // A dead or merged INSEE code is a 404 upstream, and here; the Géo API
      // down, or slow, is not "no such commune".
      if (e instanceof UpstreamNotFound) return reply.notFound("Commune introuvable");
      throw e;
    }
  });
}
