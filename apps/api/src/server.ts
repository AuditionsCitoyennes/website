import Fastify, { LogController } from "fastify";
import { STATUS_CODES } from "node:http";
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
import placeRoutes from "./modules/places/routes";
import placeReadRoutes from "./modules/places/readRoutes";
import verifyRoutes from "./modules/verification/routes";
import meRoutes from "./modules/account/routes";
import onlineTestimonyRoutes from "./modules/online-testimonies/routes";
import outboxRoutes from "./modules/outbox/routes";
import hookRoutes from "./modules/hooks/routes";

/** Past this, a request that succeeded is still logged (with its duration). */
const SLOW_REQUEST_MS = 500;

export function buildServer() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // A request's bearer token, cookie or proxy secret never reaches the logs.
      redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-proxy-secret"]'],
    },
    trustProxy: config.TRUST_PROXY || false,
    // The lines below (onResponse) replace Fastify's two per request: the map
    // poll every 2.5 s and a drill's tile burst wrote hundreds for nothing.
    logController: new LogController({ disableRequestLogging: true }),
    // A proxy's request id, when it sends one, so a screenshot of the generic
    // error (see setErrorHandler) maps to a log line.
    requestIdHeader: "x-request-id",
    // A client that stops sending halfway is dropped after 30 s instead of
    // holding its socket; keep-alive outlives the proxies' idle timeout (a
    // socket the proxy still believes open must not be closed under it).
    requestTimeout: 30_000,
    keepAliveTimeout: 65_000,
  });
  setCacheLogger(app.log);
  setGeocodeLogger(app.log);
  setEmailLogger(app.log);

  // One line per request that failed or dawdled, none for the rest. The route
  // pattern, not the URL: a verification token in the path never reaches the
  // logs.
  app.addHook("onResponse", (req, reply, done) => {
    const status = reply.statusCode;
    const ms = reply.elapsedTime;
    if (status >= 400 || ms > SLOW_REQUEST_MS) {
      const line = { method: req.method, route: req.routeOptions.url ?? req.url, status, ms };
      if (status >= 500) req.log.error(line, "request failed");
      else if (status >= 400) req.log.warn(line, "request refused");
      else req.log.info(line, "slow request");
    }
    done();
  });

  // What a client is told when a request fails. A 4xx (sensible's helpers,
  // the body parser, validation) and a deliberate 502/503/504 say what was
  // wrong, in their own words, as before. A plain 500 — an upstream's raw
  // error text, an exception nobody mapped — is logged whole and answered
  // with one generic line and the request id to quote: PostgREST's constraint
  // names and column lists used to reach the screen.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status !== 500) return reply.send(err);
    req.log.error({ err }, "request failed");
    return reply.code(500).send({
      statusCode: 500,
      error: STATUS_CODES[500],
      message: `Une erreur est survenue (référence : ${req.id}).`,
    });
  });

  // Production pins the single web origin; in local development, accept any
  // localhost port so several dev servers (e.g. parallel Vite instances) can
  // reach the API.
  app.register(cors, {
    origin: isDev
      ? (origin, cb) =>
          cb(null, !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
      : config.WEB_ORIGIN,
    credentials: true,
    // A browser may keep a preflight's answer 2 h (Chrome's cap): the admin
    // UI's mutations stop paying an OPTIONS round trip each.
    maxAge: 7200,
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
  app.register(placeRoutes, { prefix: "/api/admin/places" });
  // /api/places…, and an audition's testimony pages and the admin list's
  // filters beside /api/auditions (full paths).
  app.register(placeReadRoutes);
  app.register(verifyRoutes, { prefix: "/api/verify" });
  app.register(meRoutes, { prefix: "/api/me" });
  app.register(onlineTestimonyRoutes, { prefix: "/api/online-testimonies" });
  if (emailMode === "outbox") app.register(outboxRoutes, { prefix: "/api/outbox" });
  if (config.SEND_EMAIL_HOOK_SECRET) app.register(hookRoutes, { prefix: "/api/hooks" });

  return app;
}
