import { config } from "../../config";
import {
  EmailRejectedError,
  EmailRetryableError,
  EmailsDisabledError,
  esc,
  FROM,
  REPLY_TO,
  requireKey,
  resendPost,
  wrapBrandedEmail,
} from "./resend";

export interface VerificationRecipient {
  email: string;
  personName: string;
  verificationToken: string;
}

export interface SendReport {
  success: boolean;
  sent: number;
  failed: number;
  results: { email: string; success: boolean; error?: string }[];
}

// ---- Templates (verbatim port) ---------------------------------------------

function buildVerificationHtml(
  personName: string,
  auditionLocation: string,
  auditionDate: string,
  verificationUrl: string,
): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vérifiez votre témoignage</title>
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
              <h2 style="margin: 0 0 20px 0; font-family: 'Source Sans 3', 'Segoe UI', Roboto, Arial, sans-serif; font-size: 22px; font-weight: 600; color: #1a1f28;">
                Bonjour ${personName},
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #1a1f28;">
                Votre témoignage lors de l'audition citoyenne a été enregistré :
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
                <tr>
                  <td style="background-color: #f4ebff; border-left: 4px solid #7a29cc; padding: 16px 20px; border-radius: 0 6px 6px 0;">
                    <p style="margin: 0; font-size: 15px; color: #6b00cc;">
                      <strong>${auditionLocation}</strong> &mdash; ${auditionDate}
                    </p>
                  </td>
                </tr>
              </table>
              <p style="margin: 0 0 28px 0; font-size: 16px; color: #1a1f28;">
                Nous vous invitons à vérifier et valider votre témoignage :
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 0 0 28px 0;">
                    <a href="${verificationUrl}"
                       style="display: inline-block; background-color: #7a29cc; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 6px; font-family: 'Source Sans 3', 'Segoe UI', Roboto, Arial, sans-serif; font-size: 16px; font-weight: 600; letter-spacing: 0.5px;">
                      Vérifier mon témoignage
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #737a82;">
                Si vous n'avez pas participé à cette audition, vous pouvez ignorer cet email ou refuser le témoignage via le lien ci-dessus.
              </p>
              <p style="margin: 0; font-size: 13px; color: #737a82;">
                Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
                <a href="${verificationUrl}" style="color: #7a29cc; word-break: break-all;">${verificationUrl}</a>
              </p>
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

function buildVerificationText(
  personName: string,
  auditionLocation: string,
  auditionDate: string,
  verificationUrl: string,
): string {
  return `Bonjour ${personName},\n\nVotre témoignage lors de l'audition à ${auditionLocation} le ${auditionDate} a été enregistré.\n\nNous vous invitons à le vérifier et valider en suivant ce lien :\n${verificationUrl}\n\nSi vous n'avez pas participé à cette audition, vous pouvez ignorer cet email ou refuser le témoignage via le lien ci-dessus.\n\n— Auditions Citoyennes\nhttps://auditionscitoyennes.com`;
}

// ---- Senders ----------------------------------------------------------------

/**
 * Batch-send testimony verification emails (chunks of 100 via Resend's batch
 * API). Returns a per-recipient report; throws EmailsDisabledError without a key.
 */
export async function sendVerificationEmails(
  recipients: VerificationRecipient[],
  auditionLocation: string,
  auditionDate: string,
): Promise<SendReport> {
  requireKey();
  const results: SendReport["results"] = [];

  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100);
    const emails = chunk.map((r) => {
      const verificationUrl = `${config.PUBLIC_APP_URL}/verifier/${r.verificationToken}`;
      return {
        from: FROM,
        reply_to: REPLY_TO,
        to: [r.email],
        subject: `${r.personName}, validez votre témoignage`,
        text: buildVerificationText(r.personName, auditionLocation, auditionDate, verificationUrl),
        html: buildVerificationHtml(
          esc(r.personName),
          esc(auditionLocation),
          esc(auditionDate),
          verificationUrl,
        ),
      };
    });

    try {
      const res = await resendPost("/emails/batch", emails);
      if (!res.ok) {
        const errText = await res.text();
        for (const r of chunk) results.push({ email: r.email, success: false, error: errText });
      } else {
        for (const r of chunk) results.push({ email: r.email, success: true });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const r of chunk) results.push({ email: r.email, success: false, error: message });
    }
  }

  const sent = results.filter((r) => r.success).length;
  const failed = results.length - sent;
  return { success: failed === 0, sent, failed, results };
}

/**
 * A visitor's online testimony: the link that publishes it. Nothing the
 * visitor typed goes into the subject (anyone can type anything into a public
 * form, and this is sent from our domain); only the town hall's name, which
 * the server resolved itself, is in the body.
 */
export async function sendOnlineVerificationEmail(
  email: string,
  verificationToken: string,
  townHall: string,
  auditionTitle: string,
): Promise<void> {
  const verificationUrl = `${config.PUBLIC_APP_URL}/verifier/${verificationToken}`;
  const body = `              <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 600; color: #1a1f28;">
                Merci pour votre témoignage
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #1a1f28;">
                Votre témoignage a bien été reçu. Il rejoindra l'« ${esc(auditionTitle)} » de la ${esc(townHall)}.
              </p>
              <p style="margin: 0 0 24px 0; font-size: 16px; color: #1a1f28;">
                Il ne sera publié qu'une fois que vous l'aurez validé. Vous pourrez le relire, et le corriger si besoin :
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 8px 0 28px 0;">
                    <a href="${verificationUrl}" style="display: inline-block; background-color: #7a29cc; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600;">
                      Valider mon témoignage
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 0 0 12px 0; font-size: 14px; color: #737a82;">
                Ce lien est valable 14 jours. Votre adresse email n'est jamais publiée.
              </p>
              <p style="margin: 0; font-size: 14px; color: #737a82;">
                Vous n'êtes pas à l'origine de ce message ? Ignorez-le : rien ne sera publié. Le même lien permet aussi de supprimer ce témoignage.
              </p>`;
  const text = [
    "Merci pour votre témoignage",
    "",
    `Votre témoignage a bien été reçu. Il rejoindra l'« ${auditionTitle} » de la ${townHall}.`,
    "Il ne sera publié qu'une fois que vous l'aurez validé. Vous pourrez le relire, et le corriger si besoin :",
    "",
    verificationUrl,
    "",
    "Ce lien est valable 14 jours. Votre adresse email n'est jamais publiée.",
    "Vous n'êtes pas à l'origine de ce message ? Ignorez-le : rien ne sera publié. Le même lien permet aussi de supprimer ce témoignage.",
  ].join("\n");

  const post = () =>
    resendPost(
      "/emails",
      {
        from: FROM,
        reply_to: REPLY_TO,
        to: [email],
        subject: "Validez votre témoignage",
        text,
        html: wrapBrandedEmail("Validez votre témoignage", body),
      },
      // The same key on both tries: an email Resend had accepted is not sent twice.
      `online-testimony-${verificationToken}`,
    );
  // Once more, a second later, when the first try may or may not have gone
  // through (a timeout past Resend's answer, a 5xx, the network). A refusal
  // (a 4xx other than 429) is final: EmailRejectedError at once.
  try {
    await sendOnce(post);
  } catch (e) {
    if (!(e instanceof EmailRetryableError)) throw e;
    await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    await sendOnce(post);
  }
}

const RETRY_AFTER_MS = 1000;

/** One try, its outcome typed: ok, EmailRetryableError or EmailRejectedError. */
async function sendOnce(post: () => Promise<Response>): Promise<void> {
  let res: Response;
  try {
    res = await post();
  } catch (e) {
    if (e instanceof EmailsDisabledError) throw e;
    throw new EmailRetryableError(e instanceof Error ? e.message : String(e));
  }
  if (res.ok) return;
  const detail = await res.text().catch(() => "");
  if (res.status === 429 || res.status >= 500) {
    const after = Number(res.headers.get("retry-after"));
    throw new EmailRetryableError(
      `Resend ${res.status}: ${detail}`,
      Number.isFinite(after) && after > 0 ? after : null,
    );
  }
  throw new EmailRejectedError(`Resend ${res.status}: ${detail}`, res.status);
}
