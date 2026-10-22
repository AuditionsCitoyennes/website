import { config, emailMode } from "../../config";

// Resend email service — templates ported verbatim from the previous
// edge functions (send-verification-email, handle-registration).
// Uses Resend's REST API directly to avoid an extra dependency.

export const FROM = "Auditions Citoyennes <noreply@auditionscitoyennes.com>";
export const REPLY_TO = "noreply@auditionscitoyennes.com";

export class EmailsDisabledError extends Error {
  constructor() {
    super("RESEND_API_KEY n'est pas configuré — envoi d'emails indisponible.");
    this.name = "EmailsDisabledError";
  }
}

/** Resend refused this email for good (a 4xx other than 429): sending it again would not help. */
export class EmailRejectedError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "EmailRejectedError";
  }
}

/**
 * The send may or may not have gone through — a timeout, the network, a 5xx,
 * a 429: safe to try again with the same Idempotency-Key (Resend dedups), and
 * to tell the sender to come back after `retryAfterSeconds` when known.
 */
export class EmailRetryableError extends Error {
  constructor(
    message: string,
    public retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "EmailRetryableError";
  }
}

export function requireKey(): string {
  if (!config.RESEND_API_KEY) throw new EmailsDisabledError();
  return config.RESEND_API_KEY;
}

/** Escape user-provided values interpolated into email HTML. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface OutgoingEmail {
  to: string | string[];
  subject: string;
  [field: string]: unknown;
}

interface EmailLogger {
  info: (obj: object, msg: string) => void;
}

let log: EmailLogger = { info: (obj, msg) => console.info(msg, obj) };

/** Route EMAIL_MODE=log's lines through the app's logger. */
export function setEmailLogger(logger: EmailLogger): void {
  log = logger;
}

/** EMAIL_MODE=redirect: to the one inbox, its subject saying who it was for. */
function redirected(email: OutgoingEmail): OutgoingEmail {
  const to = ([] as string[]).concat(email.to);
  const rest = { ...email };
  delete rest.cc;
  delete rest.bcc;
  return {
    ...rest,
    to: [config.EMAIL_REDIRECT_TO!],
    subject: `[${config.APP_ENV} → ${to.join(", ")}] ${email.subject}`,
  };
}

/**
 * Every email goes through here (one, or a batch on "/emails/batch"), so
 * EMAIL_MODE holds everywhere: "redirect" rewrites the recipients, "log"
 * sends nothing and answers as Resend would.
 */
export async function resendPost(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  const batch = path === "/emails/batch";
  const emails = (batch ? body : [body]) as OutgoingEmail[];
  if (emailMode === "log") {
    for (const e of emails) {
      log.info({ to: e.to, subject: e.subject }, "email not sent (EMAIL_MODE=log)");
    }
    const ids = emails.map(() => ({ id: "logged" }));
    return Response.json(batch ? { data: ids } : ids[0]);
  }
  if (emailMode === "redirect") {
    const out = emails.map(redirected);
    body = batch ? out : out[0];
  }
  return fetch(`https://api.resend.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireKey()}`,
      "Content-Type": "application/json",
      // The same email is never sent twice when a timed-out call is retried.
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

export function wrapBrandedEmail(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f7; font-family: 'Source Sans 3', 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #1a1f28;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f7; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <tr>
            <td style="background: linear-gradient(135deg, #7a29cc 0%, #9f4de6 100%); padding: 36px 24px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; font-family: 'Bebas Neue', 'Arial Black', Arial, sans-serif; font-size: 32px; font-weight: 400; letter-spacing: 3px; text-transform: uppercase; color: #ffffff;">
                Auditions Citoyennes
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background-color: #ffffff; padding: 40px 32px; border-left: 1px solid #e6e6e6; border-right: 1px solid #e6e6e6;">
${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background-color: #f5f5f7; padding: 24px 32px; border-top: 1px solid #e6e6e6; border-left: 1px solid #e6e6e6; border-right: 1px solid #e6e6e6; border-bottom: 1px solid #e6e6e6; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; font-size: 12px; color: #737a82; text-align: center;">
                Cet email a été envoyé par <a href="https://auditionscitoyennes.com" style="color: #7a29cc; text-decoration: none;">Auditions Citoyennes</a>.<br>
                Il s'agit d'un message automatique, merci de ne pas y répondre.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
