import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";
import { config } from "../config";
import { cappedFetch } from "./cappedFetch";
import { timedFetch } from "./timedFetch";

type DB = SupabaseClient<Database>;

/**
 * Service-role client — bypasses RLS. Use ONLY for privileged operations
 * (role management, account deletion, sending emails, AI analysis writes).
 * Falls back to the anon key if no service role is configured (privileged
 * ops will then fail RLS, but the server still boots). Every client's calls
 * have a time limit (lib/timedFetch.ts).
 */
export const adminClient: DB = createClient<Database>(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch() } },
);

/**
 * The service-role client of the place reads (modules/places/read.ts): an
 * answer heavier than `maxBytes` is dropped unread, and the call fails with
 * an AnswerTooLargeError (lib/cappedFetch.ts, mapped by lib/dbGate.ts).
 */
export function cappedServiceClient(maxBytes: number): DB {
  return createClient<Database>(
    config.SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: cappedFetch(maxBytes, timedFetch()) },
    },
  );
}

/** Anonymous client — RLS applies as the `anon` role (public reads only). */
export const publicClient: DB = createClient<Database>(
  config.SUPABASE_URL,
  config.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch() } },
);

/**
 * Per-request client carrying the caller's JWT, so existing RLS policies
 * enforce exactly as before (admins scoped to their content, etc.).
 *
 * Built with `accessToken`, not a header: supabase-js then skips building a
 * GoTrue client for the request and no longer awaits `auth.getSession()`
 * before every query. The price: `req.supabase.auth.*` MUST NEVER be used —
 * supabase-js throws on it. The caller is already known (lib/auth.ts), and
 * anything about users goes through `adminClient.auth.admin`.
 */
export function clientForToken(token: string): DB {
  return createClient<Database>(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    accessToken: async () => token,
    global: { fetch: timedFetch() },
  });
}
