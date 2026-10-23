import type { FastifyInstance } from "fastify";
import { config, hasServiceRole } from "../../config";

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (req) => ({
    status: "ok",
    serviceRole: hasServiceRole,
    version: config.APP_VERSION,
    // Outside production: the caller's address as the API reads it, to see at
    // a glance whether TRUST_PROXY matches the proxies in front of it (one
    // shared address would put every visitor under the same rate limit).
    ...(config.APP_ENV !== "production" && { ip: req.ip }),
  }));
}
