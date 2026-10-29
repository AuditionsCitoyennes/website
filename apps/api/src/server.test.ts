import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";

// What a failing request answers: a 4xx and a deliberate 503 keep their
// wording; a plain 500 — an upstream's raw error text, an unmapped
// exception — is answered with a generic line and the request id, and the
// detail stays in the log.

Object.assign(process.env, {
  APP_ENV: "local",
  EMAIL_MODE: "log",
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_ANON_KEY: "anon",
  LOG_LEVEL: "fatal",
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json([])) as typeof fetch;

const PG_TEXT = 'new row violates row-level security policy for table "testimonies"';

let app: FastifyInstance;
before(async () => {
  const { buildServer } = await import("./server");
  app = buildServer();
  app.get("/t/throws", async () => {
    throw new Error(PG_TEXT);
  });
  app.get("/t/pg", async (_req, reply) => reply.internalServerError(PG_TEXT));
  app.get("/t/gone", async (_req, reply) => reply.notFound("Témoignage introuvable"));
  app.get("/t/closed", async (_req, reply) =>
    reply.serviceUnavailable("Le dépôt de témoignages en ligne n'est pas disponible."),
  );
  app.post("/t/small", { bodyLimit: 16 }, async () => ({ ok: true }));
  await app.ready();
});
after(async () => {
  await app.close();
  globalThis.fetch = realFetch;
});

test("an unmapped exception: 500, generic message with the request id, no detail", async () => {
  const res = await app.inject({ method: "GET", url: "/t/throws" });
  assert.equal(res.statusCode, 500);
  const body = res.json();
  assert.equal(body.statusCode, 500);
  assert.match(body.message, /^Une erreur est survenue \(référence : .+\)\.$/);
  assert.ok(!res.body.includes("row-level"), "the upstream text must not reach the client");
});

test("internalServerError(upstream text): the text stays server-side", async () => {
  const res = await app.inject({ method: "GET", url: "/t/pg" });
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes("row-level"));
  assert.match(res.json().message, /référence/);
});

test("a 4xx keeps its wording and shape", async () => {
  const res = await app.inject({ method: "GET", url: "/t/gone" });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), {
    statusCode: 404,
    error: "Not Found",
    message: "Témoignage introuvable",
  });
});

test("a deliberate 503 keeps its wording", async () => {
  const res = await app.inject({ method: "GET", url: "/t/closed" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().message, "Le dépôt de témoignages en ligne n'est pas disponible.");
});

test("a cross-origin page can read Retry-After (the map's tree waits as told)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/t/gone",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.match(String(res.headers["access-control-expose-headers"]), /\bRetry-After\b/);
});

test("an unknown route is a plain 404", async () => {
  const res = await app.inject({ method: "GET", url: "/t/nowhere" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "Not Found");
});

test("a body past a route's limit is a 413, not a 500", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/t/small",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ padding: "x".repeat(64) }),
  });
  assert.equal(res.statusCode, 413);
});

test("the request id travels: X-Request-Id in, the same id in the 500's message", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/t/throws",
    headers: { "x-request-id": "cf-ray-123" },
  });
  assert.match(res.json().message, /cf-ray-123/);
});
