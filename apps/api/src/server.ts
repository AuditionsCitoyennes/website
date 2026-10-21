import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import sensible from "@fastify/sensible";
import { config } from "./config";
import authPlugin from "./lib/auth";
import { setCacheLogger } from "./lib/cache";
import healthRoutes from "./modules/health/routes";
import auditionRoutes from "./modules/auditions/routes";
import testimonyRoutes from "./modules/testimonies/routes";
import mapRoutes from "./modules/map/routes";
import importedAuditionRoutes from "./modules/imported-auditions/routes";
import boundaryRoutes from "./modules/boundaries/routes";
import demRoutes from "./modules/dem/routes";
import adminRoutes from "./modules/admin/routes";
import verifyRoutes from "./modules/verification/routes";
import meRoutes from "./modules/account/routes";
import onlineTestimonyRoutes from "./modules/online-testimonies/routes";

export function buildServer() {
  const app = Fastify({ logger: true, trustProxy: config.TRUST_PROXY || false });
  setCacheLogger(app.log);

  // Production pins the single web origin; in dev, accept any localhost port so
  // multiple dev servers (e.g. parallel Vite instances) can reach the API.
  const isDev = process.env.NODE_ENV !== "production";
  app.register(cors, {
    origin: isDev
      ? (origin, cb) =>
          cb(null, !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
      : config.WEB_ORIGIN,
    credentials: true,
  });
  // The map/boundary payloads are large JSON with very high entropy overlap —
  // gzip takes the imported-places payload from ~440 KB to ~80 KB.
  app.register(compress, { global: true, threshold: 1024 });
  app.register(sensible);
  app.register(authPlugin);

  app.register(healthRoutes);
  app.register(auditionRoutes, { prefix: "/api/auditions" });
  app.register(testimonyRoutes, { prefix: "/api/testimonies" });
  app.register(mapRoutes, { prefix: "/api/map" });
  app.register(importedAuditionRoutes, { prefix: "/api/imported-auditions" });
  app.register(boundaryRoutes, { prefix: "/api/boundaries" });
  app.register(demRoutes, { prefix: "/api/dem" });
  app.register(adminRoutes, { prefix: "/api/admin" });
  app.register(verifyRoutes, { prefix: "/api/verify" });
  app.register(meRoutes, { prefix: "/api/me" });
  app.register(onlineTestimonyRoutes, { prefix: "/api/online-testimonies" });

  return app;
}
