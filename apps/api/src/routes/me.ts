import type { FastifyInstance } from "fastify";
import { getRoles } from "../auth";
import { adminClient } from "../supabase";
import { hasServiceRole } from "../config";

export default async function meRoutes(app: FastifyInstance) {
  // Current user + role flags.
  app.get("/", { preHandler: app.authenticate }, async (req) => {
    const roles = await getRoles(req.supabase);
    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        metadata: req.user.user_metadata,
      },
      ...roles,
    };
  });

  // Delete the caller's own account. The old app could only clean up roles
  // client-side; with the service role we actually delete the auth user.
  app.delete("/", { preHandler: app.authenticate }, async (req, reply) => {
    if (!hasServiceRole) {
      return reply.code(503).send({
        error:
          "SUPABASE_SERVICE_ROLE_KEY n'est pas configuré — suppression de compte indisponible.",
      });
    }

    await req.supabase.rpc("insert_audit_log", {
      p_user_id: req.user.id,
      p_action: "account_deleted",
      p_target_type: "user",
      p_target_id: req.user.id,
      p_metadata: { target_email: req.user.email },
    });

    // Roles first (service client bypasses RLS), then the auth user.
    await adminClient.from("user_roles").delete().eq("user_id", req.user.id);
    const { error } = await adminClient.auth.admin.deleteUser(req.user.id);
    if (error) return reply.internalServerError(error.message);

    return reply.code(204).send();
  });
}
