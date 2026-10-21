import { config } from "../../config";
import { esc, FROM, REPLY_TO, resendPost, wrapBrandedEmail } from "./resend";

/** Registration approved — invite the new admin to the dashboard. */
export async function sendApprovalEmail(email: string, displayName: string): Promise<void> {
  const adminUrl = `${config.PUBLIC_APP_URL}/admin`;
  const body = `              <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 600; color: #1a1f28;">
                Bonjour ${esc(displayName)},
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #1a1f28;">
                Votre inscription a été acceptée. Vous pouvez maintenant accéder à l'espace d'administration.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 12px 0 28px 0;">
                    <a href="${adminUrl}"
                       style="display: inline-block; background-color: #7a29cc; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 6px; font-size: 16px; font-weight: 600; letter-spacing: 0.5px;">
                      Accéder à l'administration
                    </a>
                  </td>
                </tr>
              </table>`;

  const res = await resendPost("/emails", {
    from: FROM,
    reply_to: REPLY_TO,
    to: [email],
    subject: "Votre compte a été validé",
    html: wrapBrandedEmail("Votre compte a été validé", body),
    text: `Bonjour ${displayName},\n\nVotre inscription a été acceptée. Vous pouvez maintenant accéder à l'espace d'administration :\n${adminUrl}\n\n— Auditions Citoyennes`,
  });
  if (!res.ok) throw new Error(`Resend: ${res.status} ${await res.text()}`);
}

/** Registration declined. */
export async function sendDeclineEmail(email: string, displayName: string): Promise<void> {
  const body = `              <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 600; color: #1a1f28;">
                Bonjour ${esc(displayName)},
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #1a1f28;">
                Votre demande d'inscription n'a pas été retenue.
              </p>`;

  const res = await resendPost("/emails", {
    from: FROM,
    reply_to: REPLY_TO,
    to: [email],
    subject: "Inscription non retenue",
    html: wrapBrandedEmail("Inscription non retenue", body),
    text: `Bonjour ${displayName},\n\nVotre demande d'inscription n'a pas été retenue.\n\n— Auditions Citoyennes`,
  });
  if (!res.ok) throw new Error(`Resend: ${res.status} ${await res.text()}`);
}
