import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import sensible from "@fastify/sensible";
import { config, emailMode, isDev } from "./config";
import authPlugin from "./lib/auth";
import { setCacheLogger } from "./lib/cache";
import { runActing } from "./lib/email/outbox";
import { setEmailLogger } from "./lib/email/resend";
import { fromProxy } from "./lib/visitor";
import { setGeocodeLogger } from "./modules/geo/geocode";
import healthRoutes from "./modules/health/routes";
import auditionRoutes from "./modules/auditions/routes";
import testimonyRoutes from "./modules/testimonies/routes";
import mapRoutes from "./modules/map/routes";
import boundaryRoutes from "./modules/boundaries/routes";
import demRoutes from "./modules/dem/routes";
import adminRoutes from "./modules/admin/routes";
import verifyRoutes from "./modules/verification/routes";
import meRoutes from "./modules/account/routes";
import onlineTestimonyRoutes from "./modules/online-testimonies/routes";
import outboxRoutes from "./modules/outbox/routes";
import hookRoutes from "./modules/hooks/routes";

export function buildServer() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // A request's bearer token, cookie or proxy secret never reaches the logs.
      redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-proxy-secret"]'],
    },
    trustProxy: config.TRUST_PROXY || false,
  });
  setCacheLogger(app.log);
  setGeocodeLogger(app.log);
  setEmailLogger(app.log);

  // Production pins the single web origin; in local development, accept any
  // localhost port so several dev servers (e.g. parallel Vite instances) can
  // reach the API.
  app.register(cors, {
    origin: isDev
      ? (origin, cb) =>
          cb(null, !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
      : config.WEB_ORIGIN,
    credentials: true,
  });
  // The map/boundary payloads are large JSON with very high entropy overlap.
  app.register(compress, { global: true, threshold: 1024 });
  app.register(sensible);
  app.register(authPlugin);
  // REQUIRE_PROXY: nothing but the site's proxy gets through (see config),
  // apart from the health check and Supabase Auth's signed hook.
  if (config.REQUIRE_PROXY) {
    app.addHook("onRequest", async (req, reply) => {
      // The route Fastify matched, not the raw URL: no path trick
      // ("/api/hooks/../outbox") can borrow an open route's pass.
      const route = req.routeOptions.url ?? "";
      const open =
        route === "/health" || route === "/api/health" || route.startsWith("/api/hooks/");
      if (!open && !fromProxy(req)) {
        return reply.code(403).send({ error: "Only reachable through the site." });
      }
    });
  }
  // The test outbox tags each email with whoever's action sent it: the rest
  // of every request runs knowing the request (see lib/email/outbox).
  if (emailMode === "outbox") {
    app.addHook("preHandler", (req, _reply, done) => runActing({ req }, done));
  }

  app.register(healthRoutes);
  app.register(auditionRoutes, { prefix: "/api/auditions" });
  app.register(testimonyRoutes, { prefix: "/api/testimonies" });
  app.register(mapRoutes, { prefix: "/api/map" });
  app.register(boundaryRoutes, { prefix: "/api/boundaries" });
  app.register(demRoutes, { prefix: "/api/dem" });
  app.register(adminRoutes, { prefix: "/api/admin" });
  app.register(verifyRoutes, { prefix: "/api/verify" });
  app.register(meRoutes, { prefix: "/api/me" });
  app.register(onlineTestimonyRoutes, { prefix: "/api/online-testimonies" });
  if (emailMode === "outbox") app.register(outboxRoutes, { prefix: "/api/outbox" });
  if (config.SEND_EMAIL_HOOK_SECRET) app.register(hookRoutes, { prefix: "/api/hooks" });

  return app;
}
