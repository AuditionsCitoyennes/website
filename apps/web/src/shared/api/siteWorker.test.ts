// The site's Worker (apps/web/worker/index.ts), which carries /api/* to the
// API: run in node with `fetch` replaced, to read what it would send and
// where. Only a path under /api/ is forwarded, always to the API's own
// address; the visitor's claims about their address, their cookies and their
// request id stay behind. Kept under src/ so that the root "test:scripts"
// runs it with the web app's other tests.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import worker from "../../../worker/index";

const ENV = { API_ORIGIN: "https://api.example", PROXY_SECRET: "shared-secret" };

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
}

let sent: Sent[] = [];
let answer: () => Response = () => Response.json({ ok: true });
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  answer = () => Response.json({ ok: true });
  globalThis.fetch = ((input: URL, init: { method: string; headers: Headers }) => {
    sent.push({ url: new URL(input), method: init.method, headers: init.headers });
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A visitor's request as Cloudflare hands it over: `target` is the raw path and query. */
function visit(target: string, headers: Record<string, string> = {}, env = ENV) {
  const request = new Request(`https://site.example${target}`, {
    headers: { "cf-connecting-ip": "203.0.113.7", ...headers },
  });
  return worker.fetch(request, env);
}

test("a path under /api/ goes to the API's address, with its query", async () => {
  const res = await visit("/api/places/results?q=lyon&page=2");
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url.href, "https://api.example/api/places/results?q=lyon&page=2");
  assert.equal(sent[0]?.method, "GET");
});

test("the Worker vouches for the visitor's address, and drops the visitor's own claims", async () => {
  await visit("/api/me", {
    authorization: "Bearer visitor-token",
    cookie: "a=b",
    "cf-access-jwt-assertion": "gate-token",
    "x-forwarded-for": "198.51.100.1",
    "x-real-ip": "198.51.100.1",
    "x-visitor-ip": "198.51.100.1",
    "x-proxy-secret": "guess",
    "x-request-id": "chosen-by-the-visitor",
  });
  const headers = sent[0]?.headers;
  assert.ok(headers);
  assert.equal(headers.get("x-visitor-ip"), "203.0.113.7");
  assert.equal(headers.get("x-proxy-secret"), "shared-secret");
  assert.equal(headers.get("authorization"), "Bearer visitor-token");
  assert.equal(headers.get("x-forwarded-host"), "site.example");
  assert.equal(headers.get("x-forwarded-proto"), "https");
  for (const dropped of [
    "cookie",
    "cf-connecting-ip",
    "cf-access-jwt-assertion",
    "x-forwarded-for",
    "x-real-ip",
    "x-request-id",
  ]) {
    assert.equal(headers.get(dropped), null, dropped);
  }
});

test("no address from Cloudflare, no secret sent", async () => {
  await visit("/api/health", { "cf-connecting-ip": "" });
  assert.equal(sent[0]?.headers.get("x-proxy-secret"), null);
  assert.equal(sent[0]?.headers.get("x-visitor-ip"), null);
});

test("anything not under /api/ is a 404, and nothing is sent anywhere", async () => {
  for (const target of [
    "/",
    "/api",
    "/apix/health",
    "/health",
    "/map-data/outlines/x/root.json",
    "/api/../health",
    "/api/%2e%2e/health",
    "//other.example/page",
    "/api/..//other.example/page",
    "/api/%2e%2e//other.example/page",
    "/api/%2E%2e/%2fother.example/page",
    "/api\\..\\\\other.example\\page",
    "/\\other.example/page",
  ]) {
    const res = await visit(target);
    assert.equal(res.status, 404, target);
    assert.equal(sent.length, 0, target);
  }
});

test("no path names another host: what is forwarded stays at the API's address", async () => {
  for (const target of [
    "/api//other.example/page",
    "/api/.//other.example/page",
    "/api/x/..//other.example/page",
    "/api/..%2f%2fother.example/page",
    "/api/x?//other.example/page",
    "/api/@other.example/page",
    "/api/https://other.example/page",
  ]) {
    sent = [];
    await visit(target);
    assert.equal(sent.length, 1, target);
    assert.equal(sent[0]?.url.origin, "https://api.example", target);
    assert.equal(sent[0]?.url.username, "", target);
    assert.ok(sent[0]?.url.pathname.startsWith("/api/"), target);
  }
});

test("an API address that is no URL, or an API that does not answer: 502, in French", async () => {
  const unset = await visit("/api/health", {}, { ...ENV, API_ORIGIN: "not a url" });
  assert.equal(unset.status, 502);
  assert.equal(sent.length, 0);

  globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
  const down = await visit("/api/health");
  assert.equal(down.status, 502);
  assert.match(((await down.json()) as { error: string }).error, /ne répond pas/);
});

test("the API's answer comes back as it is, redirects included", async () => {
  answer = () => new Response(null, { status: 307, headers: { location: "/api/elsewhere" } });
  const res = await visit("/api/x//y");
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), "/api/elsewhere");
});
