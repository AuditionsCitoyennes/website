import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Recipient {
  email: string;
  personName: string;
  verificationToken: string;
}

interface RequestBody {
  // Batch mode: array of recipients sharing the same audition
  recipients?: Recipient[];
  auditionLocation: string;
  auditionDate: string;
  baseUrl: string;
  // Single mode (backwards-compatible)
  email?: string;
  personName?: string;
  verificationToken?: string;
}

function buildHtml(personName: string, auditionLocation: string, auditionDate: string, verificationUrl: string): string {
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

function buildText(personName: string, auditionLocation: string, auditionDate: string, verificationUrl: string): string {
  return `Bonjour ${personName},\n\nVotre témoignage lors de l'audition à ${auditionLocation} le ${auditionDate} a été enregistré.\n\nNous vous invitons à le vérifier et valider en suivant ce lien :\n${verificationUrl}\n\nSi vous n'avez pas participé à cette audition, vous pouvez ignorer cet email ou refuser le témoignage via le lien ci-dessus.\n\n— Auditions Citoyennes\nhttps://auditionscitoyennes.com`;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body: RequestBody = await req.json();
    const { auditionLocation, auditionDate, baseUrl } = body;

    if (!auditionLocation || !auditionDate || !baseUrl) {
      throw new Error("Missing required fields: auditionLocation, auditionDate, or baseUrl");
    }

    // Build list of recipients (support both single and batch)
    const recipients: Recipient[] = body.recipients
      ? body.recipients
      : body.email && body.personName && body.verificationToken
        ? [{ email: body.email, personName: body.personName, verificationToken: body.verificationToken }]
        : [];

    if (recipients.length === 0) {
      throw new Error("No recipients provided");
    }

    const results: { email: string; success: boolean; error?: string }[] = [];

    // Use Resend batch API for multiple recipients (up to 100 per call)
    // Process in chunks of 100
    for (let i = 0; i < recipients.length; i += 100) {
      const chunk = recipients.slice(i, i + 100);

      const emails = chunk.map((r) => {
        const verificationUrl = `${baseUrl}/verifier/${r.verificationToken}`;
        return {
          from: "Auditions Citoyennes <noreply@auditionscitoyennes.com>",
          replyTo: "noreply@auditionscitoyennes.com",
          to: [r.email],
          subject: `${r.personName}, validez votre témoignage`,
          text: buildText(r.personName, auditionLocation, auditionDate, verificationUrl),
          html: buildHtml(r.personName, auditionLocation, auditionDate, verificationUrl),
        };
      });

      try {
        const batchResponse = await resend.batch.send(emails);
        // Mark all as success
        for (const r of chunk) {
          results.push({ email: r.email, success: true });
        }
        console.log(`Batch sent ${chunk.length} emails:`, batchResponse);
      } catch (batchError: any) {
        console.error(`Batch send failed for chunk starting at ${i}:`, batchError);
        // Mark all in this chunk as failed
        for (const r of chunk) {
          results.push({ email: r.email, success: false, error: batchError.message });
        }
      }
    }

    const sent = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return new Response(
      JSON.stringify({ success: failed === 0, sent, failed, results }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (error: any) {
    console.error("Error in send-verification-email function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
