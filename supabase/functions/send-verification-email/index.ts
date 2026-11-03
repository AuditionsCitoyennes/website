// The verification email of testimonies that an admin of the old site has
// just saved (edited, added, or entered with a new audition). The old site
// calls it from the browser with the public key only, so the request is
// trusted for nothing but its verification tokens: each one is looked up
// among pending testimonies, and the address, the name, the audition and the
// link all come from the database and from this function. A token that
// matches no pending testimony sends nothing.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { Resend } from "npm:resend@2.0.0";

// Where the links lead: the old site's /verifier/<token> page.
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://www.auditionscitoyennes.com").replace(/\/+$/, "");
// Tests only: build the emails, send nothing, and answer with what would go.
const DRY_RUN = Deno.env.get("EMAIL_DRY_RUN") === "1";
// The old site sends at most one audition's witnesses at a time.
const MAX_TOKENS = 100;
const TOKEN = /^[A-Za-z0-9-]{8,64}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// One line, for the subject.
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

function formatDate(date: string, monthOnly: boolean): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("fr-FR", {
    ...(monthOnly ? {} : { day: "numeric" }),
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// The tokens of the request, in either of the old site's shapes: one
// testimony (`verificationToken`) or an audition's witnesses (`recipients`).
function requestedTokens(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as { recipients?: unknown; verificationToken?: unknown };
  const raw = Array.isArray(b.recipients)
    ? b.recipients.map((r) => (r && typeof r === "object" ? (r as { verificationToken?: unknown }).verificationToken : undefined))
    : [b.verificationToken];
  const tokens = raw.filter((t): t is string => typeof t === "string" && TOKEN.test(t));
  return [...new Set(tokens)].slice(0, MAX_TOKENS);
}

interface PendingTestimony {
  email: string;
  person_name: string;
  verification_token: string;
  auditions: { location: string; date: string; audition_en_ligne: boolean } | null;
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
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const tokens = requestedTokens(body);
    if (tokens.length === 0) {
      return json({ error: "No verification token" }, 400);
    }

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await db
      .from("testimonies")
      .select("email, person_name, verification_token, auditions(location, date, audition_en_ligne)")
      .in("verification_token", tokens)
      .eq("verification_status", "pending")
      .not("email", "is", null);
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as unknown as PendingTestimony[]).filter((r) => r.email && r.auditions);
    if (rows.length === 0) {
      return json({ error: "No pending testimony for these tokens" }, 404);
    }

    const emails = rows.map((r) => {
      const a = r.auditions!;
      const auditionDate = formatDate(a.date, a.audition_en_ligne);
      const verificationUrl = `${SITE_URL}/verifier/${encodeURIComponent(r.verification_token)}`;
      return {
        from: "Auditions Citoyennes <noreply@auditionscitoyennes.com>",
        replyTo: "noreply@auditionscitoyennes.com",
        to: [r.email],
        subject: `${oneLine(r.person_name)}, validez votre témoignage`,
        text: buildText(r.person_name, a.location, auditionDate, verificationUrl),
        html: buildHtml(escapeHtml(r.person_name), escapeHtml(a.location), escapeHtml(auditionDate), escapeHtml(verificationUrl)),
      };
    });

    if (DRY_RUN) {
      return json({
        success: true,
        sent: emails.length,
        failed: 0,
        dryRun: emails.map((e) => ({ to: e.to, subject: e.subject, text: e.text, html: e.html })),
      });
    }

    const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
    const { error: sendError } = await resend.batch.send(emails);
    if (sendError) {
      console.error("Resend refused the batch:", sendError);
      return json({ success: false, sent: 0, failed: emails.length, error: "Email not sent" }, 502);
    }
    console.log(`Sent ${emails.length} verification email(s)`);
    return json({ success: true, sent: emails.length, failed: 0 });
  } catch (error) {
    console.error("Error in send-verification-email function:", error);
    return json({ error: "Internal error" }, 500);
  }
};

serve(handler);
