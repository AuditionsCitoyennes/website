import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminClient } from "../../lib/supabase";
import { hasServiceRole } from "../../config";
import { invalidateRoles, requireSuperAdmin } from "../../lib/auth";
import { sendApprovalEmail, sendDeclineEmail } from "../../lib/email/registration";
import { logAudit } from "../../lib/audit";
import { withWholeTestimonies } from "../auditions/service";

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
    const { data, error } = await req.supabase.rpc("get_pending_registrations");
    if (error) return reply.internalServerError(error.message);
    return data ?? [];
  });

  // Approve or decline a pending registration (ported from the
  // handle-registration edge function).
  app.post<{ Params: { userId: string } }>("/registrations/:userId", async (req, reply) => {
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
      invalidateRoles(userId);

      await logAudit(req.supabase, req.log, {
        actorId: req.user.id,
        action: "registration_approved",
        targetType: "user",
        targetId: userId,
        metadata: { target_email: email, target_username: username },
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
    invalidateRoles(userId);

    await logAudit(req.supabase, req.log, {
      actorId: req.user.id,
      action: "registration_declined",
      targetType: "user",
      targetId: userId,
      metadata: { target_email: email, target_username: username },
    });

    return { success: true, action: "declined", emailSent };
  });

  // ---- Roles ----

  // Roles with email/username details (RPC enforces admin visibility).
  app.get("/roles", async (req, reply) => {
    const { data, error } = await req.supabase.rpc("get_user_roles_with_details");
    if (error) return reply.internalServerError(error.message);
    return data ?? [];
  });

  app.delete<{ Params: { id: string } }>("/roles/:id", async (req, reply) => {
    if (!(await requireSuperAdmin(req, reply))) return reply;
    // A non-UUID compared to the uuid column would surface as a raw 500.
    if (!z.string().uuid().safeParse(req.params.id).success) {
      return reply.notFound("Rôle introuvable");
    }

    // One statement: the delete itself, never of a super admin's role, and
    // what it removed (for the audit entry) — instead of loading every role
    // to find this one first.
    const { data: role, error } = await req.supabase
      .from("user_roles")
      .delete()
      .eq("id", req.params.id)
      .neq("role", "super_admin")
      .select("id, user_id, role")
      .maybeSingle();
    if (error) return reply.badRequest(error.message);
    // Unknown — or a super admin's, which stays.
    if (!role) return reply.notFound("Rôle introuvable, ou rôle super admin (non supprimable)");
    invalidateRoles(role.user_id);

    await logAudit(req.supabase, req.log, {
      actorId: req.user.id,
      action: "role_deleted",
      targetType: "user",
      targetId: role.user_id,
      metadata: { role: role.role },
    });

    return { success: true };
  });

  // ---- One audition, as the reader of the audit log opens it (super admin) ----

  // Whatever its status: a draft is exactly what a super admin wants to look at
  // when the log says an admin has just added it. A draft is not readable
  // through RLS until the policy migration is applied, hence the service
  // client — reached only once the caller is known to be a super admin, and
  // for what that migration lets a super admin read anyway.
  // Explicit testimony columns: `*` would hand out emails and verification
  // tokens, which a preview has no use for.
  app.get<{ Params: { id: string } }>("/auditions/:id", async (req, reply) => {
    if (!(await requireSuperAdmin(req, reply))) return reply;
    // A non-UUID compared to the uuid column would surface as a raw 500.
    if (!z.string().uuid().safeParse(req.params.id).success) {
      return reply.notFound("Audition introuvable");
    }
    const client = hasServiceRole ? adminClient : req.supabase;
    const { data, error } = await client
      .from("auditions")
      .select(
        "id, title, date, location, content, status, created_at, testimonies(id, person_name, person_info, content, topics, verification_status, created_at)",
      )
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) return reply.internalServerError(error.message);
    if (!data) {
      // Deleted since the entry was written…
      if (hasServiceRole) return reply.notFound("Audition introuvable");
      // …or, without the service key, a draft that RLS hides: not to be
      // reported as gone.
      return reply.code(503).send({
        error:
          "SUPABASE_SERVICE_ROLE_KEY n'est pas configuré — audition illisible (brouillon) ou supprimée.",
      });
    }
    const whole = await withWholeTestimonies(client, data);
    if (whole.kind === "dbError") return reply.internalServerError(whole.message);
    return whole.audition;
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
