import { createClient } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";

// Client used ONLY for auth flows (login, signup, Google OAuth, email
// verification, password reset). All data access goes through the Fastify API.
export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      storage: localStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

// PASSWORD_RECOVERY is emitted exactly once, on a setTimeout(0) after the
// client parses the recovery URL — which can be before a lazy-loaded page
// component gets a chance to subscribe. This synchronous module-scope
// listener is registered before that tick, so the flag is never missed;
// ResetPasswordPage reads it on mount as a fallback to its live subscription.
let passwordRecoveryDetected = false;
supabase.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") passwordRecoveryDetected = true;
});

export function wasPasswordRecoveryDetected(): boolean {
  return passwordRecoveryDetected;
}
