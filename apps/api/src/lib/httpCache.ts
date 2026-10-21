import type { FastifyReply, FastifyRequest } from "fastify";
import type { CachedResponse } from "./cache";

// Sending a cachedResponse(): its validator and the freshness rule in the
// headers; a bodiless 304 when the client already holds these bytes; the
// pre-gzipped body for a client that accepts gzip (every browser), the plain
// JSON otherwise. @fastify/compress leaves a reply that already carries a
// Content-Encoding alone, so the body is never gzipped twice.

/**
 * Send a cached representation under a `Cache-Control` rule chosen by what a
 * stale copy would cost: `no-cache` where admins write (the client asks every
 * time and is answered 304 while nothing changed), `public, max-age=…` where
 * the data is static or pre-baked.
 */
export function sendCached(
  req: FastifyRequest,
  reply: FastifyReply,
  res: CachedResponse,
  cacheControl: string,
): FastifyReply {
  reply.header("ETag", res.etag);
  reply.header("Cache-Control", cacheControl);
  // One URL, two bodies: a shared cache keys its copies on the encoding.
  vary(reply, "Accept-Encoding");
  if (matches(req.headers["if-none-match"], res.etag)) return reply.code(304).send();
  reply.header("Content-Type", "application/json; charset=utf-8");
  if (acceptsGzip(req.headers["accept-encoding"])) {
    reply.header("Content-Encoding", "gzip");
    return reply.send(res.gz);
  }
  return reply.send(res.json);
}

/** Add a field to `Vary` without dropping what is there (@fastify/cors's Origin). */
function vary(reply: FastifyReply, field: string): void {
  const current = reply.getHeader("Vary");
  const list = Array.isArray(current) ? current.join(", ") : current ? String(current) : "";
  const fields = list.split(",").map((f) => f.trim().toLowerCase());
  if (fields.includes(field.toLowerCase())) return;
  reply.header("Vary", list ? `${list}, ${field}` : field);
}

/** If-None-Match (RFC 9110 §13.1.2): a list of tags, or `*`; weak and strong forms of a tag match. */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const tag = etag.replace(/^W\//, "");
  return ifNoneMatch.split(",").some((candidate) => {
    const c = candidate.trim();
    return c === "*" || c.replace(/^W\//, "") === tag;
  });
}

/** Whether the client takes gzip: listed with a weight above 0, or covered by a `*` that is. */
function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (!acceptEncoding) return false;
  let wildcard = false;
  for (const part of acceptEncoding.split(",")) {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    const name = coding.trim();
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const weight = q ? Number(q.slice(2)) : 1;
    if (name === "gzip" || name === "x-gzip") return weight > 0;
    if (name === "*") wildcard = weight > 0;
  }
  return wildcard;
}
