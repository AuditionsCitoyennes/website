// The Supabase client, downloaded when it is needed (authClientSwitch.ts):
// nothing of the page's first files imports shared/api/supabase.ts. The
// session store (features/auth/store.ts) and apiFetch (client.ts) go through
// here; the pages that sign in (the sign-in page, the password page, the
// admin area) import supabase.ts as before, in their own chunks.
//
// However the client comes to be made — loadSupabase() here, or a page's
// chunk importing supabase.ts —, supabase.ts tells this module
// (supabaseMade), and every caller of whenSupabase() hears of it once: the
// session store follows a sign-in on the sign-in page this way.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";
import { mayHaveSession } from "./authPresence";

export type AuthClientInstance = SupabaseClient<Database>;

let made: AuthClientInstance | null = null;
let loading: Promise<AuthClientInstance> | null = null;
const waiting: ((client: AuthClientInstance) => void)[] = [];

/** Called by supabase.ts once, as it makes the client. */
export function supabaseMade(client: AuthClientInstance) {
  made = client;
  for (const run of waiting.splice(0)) run(client);
}

/** The client, if it is made already; null otherwise (nothing downloaded). */
export function supabaseIfMade(): AuthClientInstance | null {
  return made;
}

/** The client, downloaded and made on the first call. */
export function loadSupabase(): Promise<AuthClientInstance> {
  if (made) return Promise.resolve(made);
  loading ??= import("./supabase").then((m) => m.supabase);
  return loading;
}

/** `run` with the client once it is made (now, if it is): once. */
export function whenSupabase(run: (client: AuthClientInstance) => void) {
  if (made) run(made);
  else waiting.push(run);
}

/** Whether this visit may have a signed-in account (authPresence.ts), from
 *  this browser's storage and address. */
export function visitMayHaveSession(): boolean {
  let keys: string[] = [];
  try {
    keys = Object.keys(localStorage);
  } catch {
    /* storage blocked: no session can be kept either */
  }
  return mayHaveSession(keys, window.location.search, window.location.hash);
}
