import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";
import { config } from "./config";

type DB = SupabaseClient<Database>;

/**
 * Service-role client — bypasses RLS. Use ONLY for privileged operations
 * (role management, account deletion, sending emails, AI analysis writes).
 * Falls back to the anon key if no service role is configured (privileged
 * ops will then fail RLS, but the server still boots).
 */
export const adminClient: DB = createClient<Database>(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** Anonymous client — RLS applies as the `anon` role (public reads only). */
export const publicClient: DB = createClient<Database>(
  config.SUPABASE_URL,
  config.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/**
 * Per-request client carrying the caller's JWT, so existing RLS policies
 * enforce exactly as before (admins scoped to their content, etc.).
 */
export function clientForToken(token: string): DB {
  return createClient<Database>(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
