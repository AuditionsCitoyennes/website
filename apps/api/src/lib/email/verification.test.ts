import { strict as assert } from "node:assert";
import { before, test } from "node:test";

// What a witness receives, frozen byte for byte: the verification email is
// its body inside the chrome every email shares (wrapBrandedEmail), and the
// result is exactly what the former standalone template produced.

Object.assign(process.env, {
  APP_ENV: "local",
  EMAIL_MODE: "log",
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_ANON_KEY: "anon",
  LOG_LEVEL: "fatal",
});

let email: typeof import("./verification");
before(async () => {
  email = await import("./verification");
});

test("the verification email is the shared chrome around its body, unchanged", () => {
  const html = email.buildVerificationHtml(
    "Zoé",
    "Mairie de Lyon",
    "12 mars 2026",
    "http://localhost:5173/verifier/tok-abc-123",
  );
  assert.equal(html, EXPECTED);
});

const EXPECTED = `<!DOCTYPE html>
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
                Bonjour Zoé,
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #1a1f28;">
                Votre témoignage lors de l'audition citoyenne a été enregistré :
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
                <tr>
                  <td style="background-color: #f4ebff; border-left: 4px solid #7a29cc; padding: 16px 20px; border-radius: 0 6px 6px 0;">
                    <p style="margin: 0; font-size: 15px; color: #6b00cc;">
                      <strong>Mairie de Lyon</strong> &mdash; 12 mars 2026
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
                    <a href="http://localhost:5173/verifier/tok-abc-123"
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
                <a href="http://localhost:5173/verifier/tok-abc-123" style="color: #7a29cc; word-break: break-all;">http://localhost:5173/verifier/tok-abc-123</a>
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
