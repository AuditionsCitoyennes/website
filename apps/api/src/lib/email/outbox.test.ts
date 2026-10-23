import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";

// EMAIL_MODE=outbox end to end, Supabase stubbed: what an email kept in the
// outbox says about who sent it, and the Send Email hook's signature.

const SECRET_BYTES = randomBytes(32);
const HOOK_SECRET = `v1,whsec_${SECRET_BYTES.toString("base64")}`;
const VIEWER = "0f8c2a1e-5b7d-4c3a-9e2f-1a2b3c4d5e6f";
const CONFIG = new URL("../../config.ts", import.meta.url).href;

Object.assign(process.env, {
  APP_ENV: "local",
  EMAIL_MODE: "outbox",
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  RESEND_API_KEY: "",
  SEND_EMAIL_HOOK_SECRET: HOOK_SECRET,
  LOG_LEVEL: "fatal",
});

interface Row {
  source: string;
  recipients: string[];
  subject: string;
  body_html: string | null;
  body_text: string | null;
  viewer: string | null;
  user_id: string | null;
}

let inserted: Row[] = [];
const realFetch = globalThis.fetch;

// The Supabase clients are made with the fetch of the moment they are created:
// stubbed before the server is imported.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  if (url.host === "supabase.test" && url.pathname === "/rest/v1/captured_emails") {
    if (init?.method === "POST") {
      const rows = JSON.parse(String(init.body)) as Row[];
      const start = inserted.length;
      inserted.push(...rows);
      return Response.json(
        rows.map((_, i) => ({
          id: `00000000-0000-4000-8000-${String(start + i).padStart(12, "0")}`,
        })),
        { status: 201 },
      );
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json([]);
  }
  throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
}) as typeof fetch;

let app: FastifyInstance;

before(async () => {
  const { buildServer } = await import("../../server");
  const { sendOnlineVerificationEmail } = await import("./verification");
  app = buildServer();
  // A write that sends an email, as the site's routes do — with a body, so the
  // request's context has to survive the body's parsing.
  app.post("/test/send", async (req) => {
    const { email } = req.body as { email: string };
    await sendOnlineVerificationEmail(
      email,
      "11111111-2222-4333-8444-555555555555",
      "Mairie de Lyon",
      "Audition test",
    );
    return { ok: true };
  });
  await app.ready();
});

after(async () => {
  await app.close();
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  inserted = [];
});

test("an email sent by a request is kept, tagged with the browser that sent it", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/test/send",
    headers: { "x-outbox-viewer": VIEWER },
    payload: { email: "temoin@exemple.fr" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(inserted.length, 1);
  const [row] = inserted;
  assert.equal(row.source, "api");
  assert.deepEqual(row.recipients, ["temoin@exemple.fr"]);
  assert.equal(row.subject, "Validez votre témoignage");
  assert.equal(row.viewer, VIEWER);
  assert.equal(row.user_id, null);
  assert.match(row.body_html ?? "", /\/verifier\/11111111-2222-4333-8444-555555555555/);
});

test("a malformed browser id is not kept", async () => {
  await app.inject({
    method: "POST",
    url: "/test/send",
    headers: { "x-outbox-viewer": "<script>" },
    payload: { email: "temoin@exemple.fr" },
  });
  assert.equal(inserted[0].viewer, null);
});

function signed(body: string, secret = SECRET_BYTES, sentAt = Math.floor(Date.now() / 1000)) {
  const id = "msg_test";
  const signature = createHmac("sha256", secret).update(`${id}.${sentAt}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(sentAt),
    "webhook-signature": `v1,${signature}`,
  };
}

function hookPayload(type: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    user: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", email: "testeur@exemple.fr", ...extra },
    email_data: {
      token: "123456",
      token_hash: "hash-main",
      redirect_to: "http://localhost:5173/admin",
      email_action_type: type,
      site_url: "http://localhost:5173",
      token_new: "654321",
      token_hash_new: type === "email_change" ? "hash-current" : "",
    },
  });
}

test("Auth's sign-up email, through the hook, is kept with its confirmation link", async () => {
  const body = hookPayload("signup");
  const res = await app.inject({
    method: "POST",
    url: "/api/hooks/send-email",
    headers: signed(body),
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {});
  assert.equal(inserted.length, 1);
  const [row] = inserted;
  assert.equal(row.source, "auth:signup");
  assert.deepEqual(row.recipients, ["testeur@exemple.fr"]);
  assert.equal(row.user_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(row.subject, "Confirmez votre adresse email");
  const link = new URL(/https?:\/\/[^\s]+/.exec(row.body_text ?? "")![0]);
  assert.equal(link.origin + link.pathname, "http://supabase.test/auth/v1/verify");
  assert.equal(link.searchParams.get("token"), "hash-main");
  assert.equal(link.searchParams.get("type"), "signup");
  assert.equal(link.searchParams.get("redirect_to"), "http://localhost:5173/admin");
});

test("a secure email change sends both addresses their own link", async () => {
  const body = hookPayload("email_change", { new_email: "nouvelle@exemple.fr" });
  const res = await app.inject({
    method: "POST",
    url: "/api/hooks/send-email",
    headers: signed(body),
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    inserted.map((r) => [r.recipients[0], /token=([^&\s]+)/.exec(r.body_text ?? "")?.[1]]),
    [
      ["testeur@exemple.fr", "hash-current"],
      ["nouvelle@exemple.fr", "hash-main"],
    ],
  );
});

test("the hook refuses a wrong signature, and a stale one", async () => {
  const body = hookPayload("recovery");
  for (const headers of [
    signed(body, randomBytes(32)),
    signed(body, SECRET_BYTES, Math.floor(Date.now() / 1000) - 600),
    { "content-type": "application/json" },
  ]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/send-email",
      headers,
      payload: body,
    });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(inserted.length, 0);
});

test("the API refuses to start in outbox mode in production", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(CONFIG)})`],
        { env: { ...process.env, APP_ENV: "production", EMAIL_MODE: "outbox" }, stdio: "pipe" },
      ),
    (e: { status: number; stderr: Buffer }) =>
      e.status === 1 && /EMAIL_MODE=outbox is refused in production/.test(String(e.stderr)),
  );
});
