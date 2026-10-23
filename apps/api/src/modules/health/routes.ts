import type { FastifyInstance, FastifyRequest } from "fastify";
import { config, hasServiceRole } from "../../config";
import { visitorIp } from "../../lib/visitor";

export default async function healthRoutes(app: FastifyInstance) {
  // Also under /api: the path the site's proxy forwards, so that a check
  // through it sees what the API makes of a visitor coming that way.
  app.get("/health", health);
  app.get("/api/health", health);
}

async function health(req: FastifyRequest) {
  return {
    status: "ok",
    serviceRole: hasServiceRole,
    version: config.APP_VERSION,
    // Outside production: the caller's address as the rate limits read it, to
    // see at a glance whether TRUST_PROXY and the site's proxy hand it over
    // (one shared address would put every visitor under the same limit).
    ...(config.APP_ENV !== "production" && { ip: visitorIp(req) }),
  };
}
