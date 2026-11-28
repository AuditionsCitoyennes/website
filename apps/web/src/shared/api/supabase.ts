import { createClient } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";
import { supabaseMade } from "./supabaseLazy";

// Client used ONLY for auth flows (login, signup, Google OAuth, email
// verification, password reset). All data access goes through the Fastify API.
// Not in the page's first files: reached through supabaseLazy.ts, or imported
// by the chunks of the pages that sign in.
//
// It never reads a session from the address (detectSessionInUrl: false): a
// return from Auth is read by the site itself, on the pages that accept one
// (shared/api/authArrival.ts, features/auth/returnArrival.ts).
export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      storage: localStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  },
);

supabaseMade(supabase);
