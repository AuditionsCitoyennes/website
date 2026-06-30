import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminClient } from "../supabase";
import { hasServiceRole } from "../config";
import { requireSuperAdmin } from "../auth";
import {
  sendApprovalEmail,
  sendDeclineEmail,
} from "../services/emails";

const registrationActionSchema = z.object({
  action: z.enum(["approve", "decline"]),
  email: z.string().email(),
  // null for OAuth signups that never completed the username prompt.
  username: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
});

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ---- Pending registrations (super admin) ----

  app.get("/registrations", async (req, reply) => {
    if (!(await requireSuperAdmin(req, reply))) return reply;
    const { data, error } = await req.supabase.rpc("get_pending_registrations" as never);
    if (error) return reply.internalServerError(error.message);
    return data ?? [];
  });

  // Approve or decline a pending registration (ported from the
  // handle-registration edge function).
  app.post<{ Params: { userId: string } }>(
    "/registrations/:userId",
    async (req, reply) => {
      if (!(await requireSuperAdmin(req, reply))) return reply;

      const parsed = registrationActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues[0]?.message ?? "Requête invalide");
      }
      const { action, email, username } = parsed.data;
      const userId = req.params.userId;
      if (!z.string().uuid().safeParse(userId).success) {
        return reply.badRequest("Identifiant utilisateur invalide");
      }
      const displayName = username || email;

      if (action === "approve") {
        // Super admins can insert roles through RLS — no service key needed.
        const { error: insertError } = await req.supabase
          .from("user_roles")
          .insert({ user_id: userId, role: "admin" });
        if (insertError) {
          return reply.internalServerError(`Failed to insert role: ${insertError.message}`);
        }

        await req.supabase.rpc("insert_audit_log", {
          p_user_id: req.user.id,
          p_action: "registration_approved",
          p_target_type: "user",
          p_target_id: userId,
          p_metadata: { target_email: email, target_username: username },
        });

        let emailSent = true;
        try {
          await sendApprovalEmail(email, displayName);
        } catch (e) {
          emailSent = false;
          req.log.warn({ err: e }, "approval email failed");
        }

        return { success: true, action: "approved", emailSent };
      }

      // Decline: deleting the auth user requires the service-role key.
      if (!hasServiceRole) {
        return reply.code(503).send({
          error:
            "SUPABASE_SERVICE_ROLE_KEY n'est pas configuré — impossible de supprimer l'utilisateur.",
        });
      }

      await req.supabase.rpc("insert_audit_log", {
        p_user_id: req.user.id,
        p_action: "registration_declined",
        p_target_type: "user",
        p_target_id: userId,
        p_metadata: { target_email: email, target_username: username },
      });

      let emailSent = true;
      try {
        await sendDeclineEmail(email, displayName);
      } catch (e) {
        emailSent = false;
        req.log.warn({ err: e }, "decline email failed");
      }

      const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
      if (deleteError) {
        return reply.internalServerError(`Failed to delete user: ${deleteError.message}`);
      }

      return { success: true, action: "declined", emailSent };
    },
  );

  // ---- Roles ----

  // Roles with email/username details (RPC enforces admin visibility).
  app.get("/roles", async (req, reply) => {
    const { data, error } = await req.supabase.rpc("get_user_roles_with_details" as never);
    if (error) return reply.internalServerError(error.message);
    return data ?? [];
  });

  app.delete<{ Params: { id: string } }>("/roles/:id", async (req, reply) => {
    if (!(await requireSuperAdmin(req, reply))) return reply;

    // Look the role up first for the audit-log metadata.
    const { data: roles } = await req.supabase.rpc("get_user_roles_with_details" as never);
    const role = ((roles ?? []) as {
      id: string;
      user_id: string;
      role: string;
      email: string | null;
      username: string | null;
    }[]).find((r) => r.id === req.params.id);
    if (!role) return reply.notFound("Rôle introuvable");
    if (role.role === "super_admin") {
      return reply.forbidden("Impossible de supprimer un rôle super admin");
    }

    const { error } = await req.supabase.from("user_roles").delete().eq("id", req.params.id);
    if (error) return reply.badRequest(error.message);

    await req.supabase.rpc("insert_audit_log", {
      p_user_id: req.user.id,
      p_action: "role_deleted",
      p_target_type: "user",
      p_target_id: role.user_id,
      p_metadata: {
        target_email: role.email,
        target_username: role.username,
        role: role.role,
      },
    });

    return { success: true };
  });

  // ---- Audit log (super admin; RPC enforces it too) ----

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/audit-log",
    async (req, reply) => {
      if (!(await requireSuperAdmin(req, reply))) return reply;
      const limit = Math.min(Number(req.query.limit) || 10, 50);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const { data, error } = await req.supabase.rpc("get_audit_log", {
        p_limit: limit,
        p_offset: offset,
      });
      if (error) return reply.internalServerError(error.message);
      return data ?? [];
    },
  );
}
