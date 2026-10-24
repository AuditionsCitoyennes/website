import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";

// REQUIRE_PROXY: the API answers the site's proxy only (and its health check,
// and Supabase Auth's signed hook) — the gate in front of the site cannot be
// walked around through the API's own address.

const SECRET = "p".repeat(48);
Object.assign(process.env, {
  APP_ENV: "staging",
  EMAIL_MODE: "outbox",
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SEND_EMAIL_HOOK_SECRET: `v1,whsec_${Buffer.from("k".repeat(32)).toString("base64")}`,
  PROXY_SECRET: SECRET,
  REQUIRE_PROXY: "true",
  LOG_LEVEL: "fatal",
});

const realFetch = globalThis.fetch;
// Supabase answers nothing: only whether the request got past the lock matters.
globalThis.fetch = (async () => Response.json([])) as typeof fetch;

let app: FastifyInstance;
before(async () => {
  const { buildServer } = await import("../server");
  app = buildServer();
  await app.ready();
});
after(async () => {
  await app.close();
  globalThis.fetch = realFetch;
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers });

test("straight to the API: refused", async () => {
  for (const url of ["/api/outbox", "/api/auditions", "/api/testimonies", "/api/hooks/../outbox"]) {
    const res = await get(url);
    assert.ok(res.statusCode === 403 || res.statusCode === 404, `${url} → ${res.statusCode}`);
    assert.notEqual(res.statusCode, 200, url);
  }
  assert.equal((await get("/api/outbox", { "x-proxy-secret": "wrong" })).statusCode, 403);
});

test("through the site's proxy: answered", async () => {
  const res = await get("/api/outbox", { "x-proxy-secret": SECRET });
  assert.equal(res.statusCode, 200);
});

test("still open: the health check and Supabase Auth's hook", async () => {
  assert.equal((await get("/health")).statusCode, 200);
  assert.equal((await get("/api/health")).statusCode, 200);
  // Past the lock, refused by its own signature check.
  const hook = await app.inject({ method: "POST", url: "/api/hooks/send-email", payload: {} });
  assert.equal(hook.statusCode, 401);
});
