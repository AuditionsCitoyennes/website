import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config";
import { authEmails, type SendEmailHook } from "../../lib/email/auth";
import { runActing } from "../../lib/email/outbox";
import { resendPost } from "../../lib/email/resend";

// Supabase Auth's Send Email hook: Auth sends no email of its own, it posts
// each one here (signed with SEND_EMAIL_HOOK_SECRET, Standard Webhooks), and
// the API sends it like its own. Registered only when the secret is set.
//
// Auth waits 5 s for the answer, then tells the person it failed: the emails
// of one call are sent together under one 4 s deadline, so the answer always
// arrives while Auth still listens. A call is known by its webhook-id and its
// body: the id is Resend's Idempotency-Key, and a call whose emails all left
// is remembered for 10 minutes — the same signed call arriving again within
// its 5 minutes answers 200 and sends nothing. A call that failed is not
// remembered: sent again, it is tried again.

/** How long the emails of one call may take, all together. */
const DEADLINE_MS = 4000;
/** How long a call that succeeded is remembered, and how many are at most (the oldest go first). */
const REMEMBER_MS = 10 * 60_000;
const REMEMBER_MAX = 5000;

/** The calls whose emails left, with when they stop being remembered; insertion order is age. */
const sent = new Map<string, number>();
/** The calls being sent now: the same call arriving meanwhile waits for that send. */
const sending = new Map<string, Promise<void>>();

/** What a call is remembered under: its webhook-id and the digest of its body. */
function callKey(id: string, body: string): string {
  return `${id}:${createHash("sha256").update(body).digest("base64url")}`;
}

function alreadySent(key: string): boolean {
  const until = sent.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  sent.delete(key);
  return false;
}

function remember(key: string): void {
  const now = Date.now();
  for (const [k, until] of sent) {
    if (until > now && sent.size < REMEMBER_MAX) break;
    sent.delete(k);
  }
  sent.set(key, now + REMEMBER_MS);
}

/** Forget every call remembered (tests). */
export function forgetHookCalls(): void {
  sent.clear();
  sending.clear();
}

/** `work`, or a rejection once `signal` aborts: nothing awaited here outlives the deadline. */
function within<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    work.then(resolve, reject);
  });
}

/** Auth's hooks answer an error this way, its message shown to the user. */
function hookError(message: string, status = 500) {
  return { error: { http_code: status, message } };
}

/** A Standard Webhooks signature (https://www.standardwebhooks.com), at most 5 minutes old. */
export function signedBy(secret: string, req: FastifyRequest, body: string): boolean {
  const id = req.headers["webhook-id"];
  const timestamp = req.headers["webhook-timestamp"];
  const signatures = req.headers["webhook-signature"];
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signatures !== "string") {
    return false;
  }
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > 300) return false;
  const key = Buffer.from(secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(" ").some((signature) => {
    const [version, value] = signature.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export default async function hookRoutes(app: FastifyInstance) {
  // The signature covers the body as sent: it is read as text, here only.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );

  app.post("/send-email", async (req, reply) => {
    const body = req.body as string;
    if (!signedBy(config.SEND_EMAIL_HOOK_SECRET, req, body)) {
      return reply.code(401).send(hookError("Signature invalide", 401));
    }
    let payload: SendEmailHook;
    try {
      payload = JSON.parse(body) as SendEmailHook;
      if (!payload.user?.email || !payload.email_data?.email_action_type) throw new Error();
    } catch {
      return reply.code(400).send(hookError("Requête invalide", 400));
    }
    // Signed, so a string (signedBy).
    const id = req.headers["webhook-id"] as string;
    const key = callKey(id, body);
    if (alreadySent(key)) return {};
    const emails = authEmails(payload);
    const actor = {
      source: `auth:${payload.email_data.email_action_type}`,
      userId: payload.user.id,
    };
    // An email change sends two emails: each its own key, the same on every try.
    const idempotencyKey = (i: number) => (i === 0 ? `auth-${id}` : `auth-${id}-${i + 1}`);
    const send = async () => {
      const deadline = AbortSignal.timeout(DEADLINE_MS);
      await within(
        deadline,
        Promise.all(
          emails.map(async (email, i) => {
            const res = await runActing(actor, () =>
              resendPost("/emails", email, idempotencyKey(i), deadline),
            );
            if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
          }),
        ),
      );
      remember(key);
    };
    let pending = sending.get(key);
    if (!pending) {
      pending = send().finally(() => sending.delete(key));
      sending.set(key, pending);
    }
    try {
      await pending;
    } catch (e) {
      req.log.error({ err: e }, "send-email hook: email not sent");
      return reply.code(500).send(hookError("L'email n'a pas pu être envoyé."));
    }
    return {};
  });
}
