import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";
import { hasServiceRole } from "../config";
import { adminClient, clientForToken } from "./supabase";

/** The caller, as the JWT says: the only fields the routes read. */
export interface AuthUser {
  id: string;
  email?: string;
  user_metadata: Record<string, unknown>;
}

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler that requires a valid Supabase JWT. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: AuthUser;
    token: string;
    /** RLS-scoped Supabase client for the authenticated caller (data only: see clientForToken). */
    supabase: SupabaseClient<Database>;
  }
}

export default fp(async (app) => {
  app.decorateRequest("user", null as unknown as AuthUser);
  app.decorateRequest("token", "");
  app.decorateRequest("supabase", null as unknown as SupabaseClient<Database>);

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Non authentifié" });
    }
    const token = header.slice(7);
    // Verified here, against the project's public signing key (JWKS, fetched
    // once and kept 10 min by supabase-js): no round trip to GoTrue per
    // request, which getUser() made (~190 ms). The project signs with ES256;
    // on a token signed with the legacy HS256 secret supabase-js falls back to
    // getUser() by itself. Revocation is then bounded by `exp` (≤ 1 h):
    // acceptable for an admin UI.
    const { data, error } = await adminClient.auth.getClaims(token);
    if (error || !data) {
      return reply.code(401).send({ error: "Session invalide" });
    }
    const { claims } = data;
    req.user = {
      id: claims.sub,
      email: claims.email,
      user_metadata: (claims.user_metadata as Record<string, unknown> | undefined) ?? {},
    };
    req.token = token;
    req.supabase = clientForToken(token);
  });
});

// ---- Roles ------------------------------------------------------------------

export interface Roles {
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

// One roles read per user per minute, not two RPCs per request: an admin
// mutation spent ~340 ms in the pair before its query. Bounded, so a flood
// of callers cannot grow it; the two role-writing routes and the account
// deletion drop the entry they touch, so a change made through the API shows
// at once. One made elsewhere (the old app) shows within ROLES_TTL_MS.
const ROLES_TTL_MS = 60_000;
const ROLES_MAX = 1000;
const roles = new Map<string, { until: number; value: Roles }>();

async function fetchRoles(req: FastifyRequest): Promise<Roles> {
  if (hasServiceRole) {
    // One read, past RLS (a plain admin may not read user_roles at all).
    const { data, error } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", req.user.id);
    if (error) throw new Error(error.message);
    const set = new Set((data ?? []).map((r) => r.role));
    return { isAdmin: set.has("admin"), isSuperAdmin: set.has("super_admin") };
  }
  // Without the service key: the SECURITY DEFINER pair, as the caller.
  const [admin, superAdmin] = await Promise.all([
    req.supabase.rpc("is_admin"),
    req.supabase.rpc("is_super_admin"),
  ]);
  return { isAdmin: !!admin.data, isSuperAdmin: !!superAdmin.data };
}

/** The caller's admin / super-admin flags, memoised per user id for a minute. */
export async function getRoles(req: FastifyRequest): Promise<Roles> {
  const id = req.user.id;
  const now = Date.now();
  const hit = roles.get(id);
  if (hit && hit.until > now) return hit.value;
  const value = await fetchRoles(req);
  roles.delete(id);
  roles.set(id, { until: now + ROLES_TTL_MS, value });
  // Insertion order: the oldest entry goes first.
  while (roles.size > ROLES_MAX) roles.delete(roles.keys().next().value!);
  return value;
}

/** Forget a user's memoised roles — after writing them, or deleting the user. */
export function invalidateRoles(userId: string): void {
  roles.delete(userId);
}

/**
 * 403 unless the caller has the admin or super_admin role. Required on every
 * mutation route: the legacy `auditions` RLS policies allow ANY authenticated
 * user to write, so the API is the enforcement point until the tightening
 * migration is applied.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const { isAdmin, isSuperAdmin } = await getRoles(req);
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
  const { isSuperAdmin } = await getRoles(req);
  if (!isSuperAdmin) {
    reply.forbidden("Accès non autorisé");
    return false;
  }
  return true;
}
