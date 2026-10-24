import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { config } from "../config";

/**
 * The visitor's address, for the rate limits. Through the site's own proxy
 * (the Cloudflare Worker in front of the web app, apps/web/worker) every
 * request comes from one of Cloudflare's addresses: the Worker passes the
 * visitor's in X-Visitor-IP, believed only alongside the shared PROXY_SECRET.
 * Any other request — straight to the API — is what TRUST_PROXY makes of it.
 */
export function visitorIp(req: FastifyRequest): string {
  const ip = req.headers["x-visitor-ip"];
  if (typeof ip === "string" && isIP(ip) && fromProxy(req)) return ip;
  return req.ip;
}

/** The request came through the site's proxy: it carries PROXY_SECRET. */
export function fromProxy(req: FastifyRequest): boolean {
  const secret = config.PROXY_SECRET;
  const given = req.headers["x-proxy-secret"];
  if (!secret || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
