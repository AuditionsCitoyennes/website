import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";
import { adminClient, clientForToken } from "./supabase";

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler that requires a valid Supabase JWT. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: User;
    token: string;
    /** RLS-scoped Supabase client for the authenticated caller. */
    supabase: SupabaseClient<Database>;
  }
}

export default fp(async (app) => {
  app.decorateRequest("user", null as unknown as User);
  app.decorateRequest("token", "");
  app.decorateRequest("supabase", null as unknown as SupabaseClient<Database>);

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Non authentifié" });
    }
    const token = header.slice(7);
    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data.user) {
      return reply.code(401).send({ error: "Session invalide" });
    }
    req.user = data.user;
    req.token = token;
    req.supabase = clientForToken(token);
  });
});

/** Returns the caller's admin/super-admin flags via RLS-safe RPCs. */
export async function getRoles(supabase: SupabaseClient<Database>) {
  const [admin, superAdmin] = await Promise.all([
    supabase.rpc("is_admin"),
    supabase.rpc("is_super_admin"),
  ]);
  return { isAdmin: !!admin.data, isSuperAdmin: !!superAdmin.data };
}

/**
 * 403 unless the caller has the admin or super_admin role. Required on every
 * mutation route: the legacy `auditions` RLS policies allow ANY authenticated
 * user to write, so the API is the enforcement point until the tightening
 * migration is applied.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const { isAdmin, isSuperAdmin } = await getRoles(req.supabase);
  if (!isAdmin && !isSuperAdmin) {
    reply.forbidden("Accès non autorisé");
    return false;
  }
  return true;
}

/** 403 unless the caller is a super admin. */
export async function requireSuperAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const { data, error } = await req.supabase.rpc("is_super_admin");
  if (error || !data) {
    reply.forbidden("Accès non autorisé");
    return false;
  }
  return true;
}
