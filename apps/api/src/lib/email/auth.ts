import { config } from "../../config";
import { esc, FROM, REPLY_TO, wrapBrandedEmail } from "./resend";

// Supabase Auth's emails (sign-up confirmation, password reset…), written by
// the API when Auth hands them over through its Send Email hook — sent then
// like the API's own, so they follow EMAIL_MODE (into the outbox on staging).

/** What Auth sends the hook (https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook). */
export interface SendEmailHook {
  user: { id: string; email: string; new_email?: string };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: string;
    site_url: string;
    token_new: string;
    token_hash_new: string;
  };
}

interface Wording {
  subject: string;
  intro: string;
  button: string;
  outro?: string;
}

const IGNORE = "Vous n'êtes pas à l'origine de cette demande ? Ignorez cet email.";

const WORDING: Record<string, Wording> = {
  signup: {
    subject: "Confirmez votre adresse email",
    intro:
      "Bienvenue sur Auditions Citoyennes. Confirmez votre adresse pour activer votre compte :",
    button: "Confirmer mon adresse",
    outro: IGNORE,
  },
  recovery: {
    subject: "Réinitialisez votre mot de passe",
    intro:
      "Vous avez demandé à changer de mot de passe. Ce lien vous permet d'en choisir un nouveau :",
    button: "Choisir un nouveau mot de passe",
    outro:
      "Vous n'êtes pas à l'origine de cette demande ? Ignorez cet email : votre mot de passe ne change pas.",
  },
  magiclink: {
    subject: "Votre lien de connexion",
    intro: "Ce lien vous connecte à Auditions Citoyennes :",
    button: "Me connecter",
    outro: IGNORE,
  },
  invite: {
    subject: "Vous êtes invité·e sur Auditions Citoyennes",
    intro: "Un compte vous attend sur Auditions Citoyennes. Acceptez l'invitation pour le créer :",
    button: "Accepter l'invitation",
  },
  email_change: {
    subject: "Confirmez le changement d'adresse",
    intro: "Confirmez le changement d'adresse email de votre compte :",
    button: "Confirmer le changement",
    outro: IGNORE,
  },
};
WORDING.email = WORDING.magiclink;

export interface AuthEmail {
  from: string;
  reply_to: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

function email(
  to: string,
  subject: string,
  paragraphs: string[],
  link?: Wording & { url: string },
): AuthEmail {
  const p = (t: string, size = 16, color = "#1a1f28") =>
    `              <p style="margin: 0 0 16px 0; font-size: ${size}px; color: ${color};">${esc(t)}</p>`;
  const button = link
    ? `              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 8px 0 28px 0;">
                    <a href="${esc(link.url)}" style="display: inline-block; background-color: #7a29cc; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600;">
                      ${esc(link.button)}
                    </a>
                  </td>
                </tr>
              </table>`
    : "";
  const body = [
    ...paragraphs.map((t) => p(t)),
    button,
    link?.outro ? p(link.outro, 14, "#737a82") : "",
  ].join("\n");
  const text = [
    ...paragraphs,
    ...(link ? ["", link.url] : []),
    ...(link?.outro ? ["", link.outro] : []),
    "",
    "— Auditions Citoyennes",
  ].join("\n");
  return {
    from: FROM,
    reply_to: REPLY_TO,
    to: [to],
    subject,
    html: wrapBrandedEmail(esc(subject), body),
    text,
  };
}

/** The link that confirms what the email asks, on Auth itself. */
function verifyUrl(type: string, tokenHash: string, redirectTo: string): string {
  const url = new URL("/auth/v1/verify", config.SUPABASE_URL);
  url.searchParams.set("token", tokenHash);
  url.searchParams.set("type", type);
  if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
  return url.toString();
}

/** The email(s) Auth asks for: two for a secure email change, one otherwise. */
export function authEmails({ user, email_data: d }: SendEmailHook): AuthEmail[] {
  const type = d.email_action_type;
  if (type === "reauthentication") {
    return [
      email(user.email, "Votre code de confirmation", [
        `Votre code de confirmation : ${d.token}`,
        IGNORE,
      ]),
    ];
  }
  const wording = WORDING[type];
  if (!wording) {
    // A kind of email this file does not know yet (Auth's security
    // notifications, say): said plainly rather than lost.
    return [email(user.email, "Auditions Citoyennes", [`Notification de votre compte (${type}).`])];
  }
  if (type === "email_change") {
    // Secure email change: the current address confirms too — and, Auth's
    // names being crossed here, with token_hash_new (see Auth's docs).
    const newAddress = user.new_email ?? user.email;
    const intro = `${wording.intro} ${user.email} → ${newAddress}`;
    const out = [
      email(newAddress, wording.subject, [intro], {
        ...wording,
        url: verifyUrl(type, d.token_hash, d.redirect_to),
      }),
    ];
    if (d.token_hash_new) {
      out.unshift(
        email(user.email, wording.subject, [intro], {
          ...wording,
          url: verifyUrl(type, d.token_hash_new, d.redirect_to),
        }),
      );
    }
    return out;
  }
  return [
    email(user.email, wording.subject, [wording.intro], {
      ...wording,
      url: verifyUrl(type, d.token_hash, d.redirect_to),
    }),
  ];
}
