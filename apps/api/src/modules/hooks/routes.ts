import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config";
import { authEmails, type SendEmailHook } from "../../lib/email/auth";
import { runActing } from "../../lib/email/outbox";
import { resendPost } from "../../lib/email/resend";

// Supabase Auth's Send Email hook: Auth sends no email of its own, it posts
// each one here (signed with SEND_EMAIL_HOOK_SECRET, Standard Webhooks), and
// the API sends it like its own. Registered only when the secret is set.

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
    const emails = authEmails(payload);
    const actor = {
      source: `auth:${payload.email_data.email_action_type}`,
      userId: payload.user.id,
    };
    try {
      for (const email of emails) {
        const res = await runActing(actor, () => resendPost("/emails", email));
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      }
    } catch (e) {
      req.log.error({ err: e }, "send-email hook: email not sent");
      return reply.code(500).send(hookError("L'email n'a pas pu être envoyé."));
    }
    return {};
  });
}
