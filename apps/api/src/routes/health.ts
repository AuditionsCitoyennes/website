import type { FastifyInstance } from "fastify";
import { hasServiceRole } from "../config";

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    serviceRole: hasServiceRole,
  }));
}
