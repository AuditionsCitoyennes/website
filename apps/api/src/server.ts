import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { config } from "./config";
import authPlugin from "./auth";
import healthRoutes from "./routes/health";
import auditionRoutes from "./routes/auditions";
import testimonyRoutes from "./routes/testimonies";
import mapRoutes from "./routes/map";
import boundaryRoutes from "./routes/boundaries";
import adminRoutes from "./routes/admin";
import verifyRoutes from "./routes/verify";
import meRoutes from "./routes/me";

export function buildServer() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  app.register(sensible);
  app.register(authPlugin);

  app.register(healthRoutes);
  app.register(auditionRoutes, { prefix: "/api/auditions" });
  app.register(testimonyRoutes, { prefix: "/api/testimonies" });
  app.register(mapRoutes, { prefix: "/api/map" });
  app.register(boundaryRoutes, { prefix: "/api/boundaries" });
  app.register(adminRoutes, { prefix: "/api/admin" });
  app.register(verifyRoutes, { prefix: "/api/verify" });
  app.register(meRoutes, { prefix: "/api/me" });

  return app;
}
