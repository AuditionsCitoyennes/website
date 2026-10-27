import type { FastifyInstance } from "fastify";
import { hasServiceRole } from "../../config";
import { requireSuperAdmin } from "../../lib/auth";
import { sweepPlacements } from "./placementJob";

/** What `?dryRun=` may say. Anything else is refused: a typo never runs a real sweep. */
const DRY_RUN = new Map([
  ["1", true],
  ["true", true],
  ["0", false],
  ["false", false],
]);

export default async function placeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Place every audition not placed yet, now (super admin): the cutover from
  // the old app. `?dryRun=1` reports what a sweep would write, writing nothing.
  app.post<{ Querystring: { dryRun?: unknown } }>("/sweep", async (req, reply) => {
    if (!(await requireSuperAdmin(req, reply))) return reply;
    // Absent: a real sweep. Repeated (an array) or misspelt: refused.
    const asked = req.query.dryRun;
    const dryRun =
      asked === undefined ? false : typeof asked === "string" ? DRY_RUN.get(asked) : undefined;
    if (dryRun === undefined) return reply.badRequest("dryRun : 1, true, 0 ou false.");
    if (!hasServiceRole) {
      return reply.serviceUnavailable(
        "SUPABASE_SERVICE_ROLE_KEY n'est pas configuré : les auditions ne peuvent pas être placées.",
      );
    }
    try {
      return { dryRun, ...(await sweepPlacements(dryRun)) };
    } catch (err) {
      req.log.error({ err }, "placement sweep failed");
      return reply.serviceUnavailable("Le placement des auditions a échoué. Réessayez.");
    }
  });
}
