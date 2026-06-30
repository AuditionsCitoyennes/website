import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface RequestBody {
  action: "approve" | "decline";
  userId: string;
  email: string;
  username: string;
  accessToken: string;
}

function buildApproveHtml(username: string, adminUrl: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Votre compte a été validé</title>
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
              <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 600; color: #1a1f28;">
                Bonjour ${username},
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
              </table>
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

function buildDeclineHtml(username: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inscription non retenue</title>
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
              <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 600; color: #1a1f28;">
                Bonjour ${username},
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #1a1f28;">
                Votre demande d'inscription n'a pas été retenue.
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

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body: RequestBody = await req.json();
    const { action, userId, email, username, accessToken } = body;

    if (!action || !userId || !email) {
      throw new Error("Missing required fields: action, userId, email");
    }

    // Verify caller is super_admin via their JWT
    if (!accessToken) {
      throw new Error("Missing access token");
    }

    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: isSuperAdmin, error: roleError } = await callerClient.rpc("is_super_admin");
    if (roleError || !isSuperAdmin) {
      return new Response(
        JSON.stringify({ error: "Accès non autorisé" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const displayName = username || email;

    // Get caller user ID for audit logging
    const { data: callerData } = await callerClient.auth.getUser();
    const callerUserId = callerData?.user?.id;

    if (action === "approve") {
      // Insert admin role
      const { error: insertError } = await adminClient
        .from("user_roles")
        .insert([{ user_id: userId, role: "admin" }]);

      if (insertError) {
        throw new Error(`Failed to insert role: ${insertError.message}`);
      }

      // Log the action
      if (callerUserId) {
        await adminClient.rpc("insert_audit_log", {
          p_user_id: callerUserId,
          p_action: "registration_approved",
          p_target_type: "user",
          p_target_id: userId,
          p_metadata: { target_email: email, target_username: username },
        });
      }

      // Send acceptance email
      const adminUrl = `${req.headers.get("origin") || "https://auditionscitoyennes.com"}/admin`;
      await resend.emails.send({
        from: "Auditions Citoyennes <noreply@auditionscitoyennes.com>",
        replyTo: "noreply@auditionscitoyennes.com",
        to: [email],
        subject: "Votre compte a été validé",
        html: buildApproveHtml(displayName, adminUrl),
        text: `Bonjour ${displayName},\n\nVotre inscription a été acceptée. Vous pouvez maintenant accéder à l'espace d'administration :\n${adminUrl}\n\n— Auditions Citoyennes`,
      });

      return new Response(
        JSON.stringify({ success: true, action: "approved" }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    } else if (action === "decline") {
      // Log the action before deleting the user
      if (callerUserId) {
        await adminClient.rpc("insert_audit_log", {
          p_user_id: callerUserId,
          p_action: "registration_declined",
          p_target_type: "user",
          p_target_id: userId,
          p_metadata: { target_email: email, target_username: username },
        });
      }

      // Send decline email first (before deleting user)
      await resend.emails.send({
        from: "Auditions Citoyennes <noreply@auditionscitoyennes.com>",
        replyTo: "noreply@auditionscitoyennes.com",
        to: [email],
        subject: "Inscription non retenue",
        html: buildDeclineHtml(displayName),
        text: `Bonjour ${displayName},\n\nVotre demande d'inscription n'a pas été retenue.\n\n— Auditions Citoyennes`,
      });

      // Delete user
      const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
      if (deleteError) {
        throw new Error(`Failed to delete user: ${deleteError.message}`);
      }

      return new Response(
        JSON.stringify({ success: true, action: "declined" }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    } else {
      throw new Error("Invalid action. Must be 'approve' or 'decline'.");
    }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error in handle-registration function:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
