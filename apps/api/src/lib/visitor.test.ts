import { strict as assert } from "node:assert";
import { before, test } from "node:test";
import type { FastifyRequest } from "fastify";

// The visitor's address behind the site's proxy: X-Visitor-IP is believed with
// the shared secret only.

const SECRET = "s".repeat(40);
Object.assign(process.env, {
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_ANON_KEY: "anon",
  PROXY_SECRET: SECRET,
});

let visitorIp: (req: FastifyRequest) => string;
before(async () => {
  ({ visitorIp } = await import("./visitor"));
});

const req = (headers: Record<string, string>) =>
  ({ ip: "203.0.113.7", headers }) as unknown as FastifyRequest;

test("the proxy's word, with the secret", () => {
  assert.equal(
    visitorIp(req({ "x-visitor-ip": "198.51.100.4", "x-proxy-secret": SECRET })),
    "198.51.100.4",
  );
  assert.equal(
    visitorIp(req({ "x-visitor-ip": "2001:db8::1", "x-proxy-secret": SECRET })),
    "2001:db8::1",
  );
});

test("anyone else's word is not taken", () => {
  for (const headers of <Record<string, string>[]>[
    { "x-visitor-ip": "198.51.100.4" },
    { "x-visitor-ip": "198.51.100.4", "x-proxy-secret": "wrong" },
    { "x-visitor-ip": "198.51.100.4", "x-proxy-secret": SECRET + "x" },
    { "x-visitor-ip": "not an address", "x-proxy-secret": SECRET },
    {},
  ]) {
    assert.equal(visitorIp(req(headers)), "203.0.113.7");
  }
});
