import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";
import { config } from "../config";
import { cappedFetch } from "./cappedFetch";
import { timedFetch } from "./timedFetch";

type DB = SupabaseClient<Database>;

/** The longest wait a gateway's Retry-After may ask for, in seconds. */
const RETRY_AFTER_MAX_S = 5;

/**
 * `base`, a Retry-After longer than 5 s in its answers brought down to 5 s:
 * supabase-js sleeps for as long as that header says before it sends a read
 * again, so a call that turns its retries back on never waits longer.
 */
export function boundedRetryAfter(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    // Read as supabase-js reads it: the leading integer, in seconds.
    const asked = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    if (!(asked > RETRY_AFTER_MAX_S)) return res;
    const headers = new Headers(res.headers);
    headers.set("retry-after", String(RETRY_AFTER_MAX_S));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/** Every client's fetch: a time limit per call (lib/timedFetch.ts), a bounded Retry-After. */
const gatewayFetch = () => boundedRetryAfter(timedFetch());

/**
 * No client sends a call again by itself: supabase-js would retry a read
 * three times on a 503, a 520 or a network error, each try under its own
 * time limit, so one call could last several times what timedFetch allows.
 * A failed read is its caller's to handle (the place reads serve the value
 * they hold: lib/dbGate.ts).
 */
const NO_RETRY = { retry: false } as const;

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
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: NO_RETRY,
    global: { fetch: gatewayFetch() },
  },
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
      db: NO_RETRY,
      global: { fetch: cappedFetch(maxBytes, gatewayFetch()) },
    },
  );
}

/** Anonymous client — RLS applies as the `anon` role (public reads only). */
export const publicClient: DB = createClient<Database>(
  config.SUPABASE_URL,
  config.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: NO_RETRY,
    global: { fetch: gatewayFetch() },
  },
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
    db: NO_RETRY,
    global: { fetch: gatewayFetch() },
  });
}
