import type { FastifyInstance } from "fastify";
import { hasServiceRole } from "../../config";
import { requireSuperAdmin } from "../../lib/auth";
import { sweepPlacements } from "./placementJob";

export default async function placeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Place every audition not placed yet, now (super admin): the cutover from
  // the old app. `?dryRun=1` reports what a sweep would write, writing nothing.
  app.post<{ Querystring: { dryRun?: string } }>("/sweep", async (req, reply) => {
    if (!(await requireSuperAdmin(req, reply))) return reply;
    if (!hasServiceRole) {
      return reply.serviceUnavailable(
        "SUPABASE_SERVICE_ROLE_KEY n'est pas configuré : les auditions ne peuvent pas être placées.",
      );
    }
    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    try {
      return { dryRun, ...(await sweepPlacements(dryRun)) };
    } catch (err) {
      req.log.error({ err }, "placement sweep failed");
      return reply.serviceUnavailable("Le placement des auditions a échoué. Réessayez.");
    }
  });
}
