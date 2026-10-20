import type { FastifyInstance } from "fastify";
import { getRoles } from "../lib/auth";
import { adminClient } from "../lib/supabase";
import { hasServiceRole } from "../config";
import { logAudit } from "../lib/audit";

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

    // Roles first (service client bypasses RLS), then the auth user.
    await adminClient.from("user_roles").delete().eq("user_id", req.user.id);
    const { error } = await adminClient.auth.admin.deleteUser(req.user.id);
    if (error) return reply.internalServerError(error.message);

    // The account is gone, and so is the caller's session: no actor (the
    // column references auth.users), written with the service client.
    await logAudit(adminClient, req.log, {
      actorId: null,
      action: "account_deleted",
      targetType: "user",
      targetId: req.user.id,
      metadata: { target_email: req.user.email },
    });

    return reply.code(204).send();
  });
}
