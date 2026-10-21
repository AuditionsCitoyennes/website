import { createClient, isAuthError, type SupabaseClient, type User } from "@supabase/supabase-js";

// Checking the CURRENT password before letting it be changed.
//
// Supabase changes a password for anyone holding a valid session; it only asks
// for the current one when the project is configured to. So the app checks it
// itself first, by signing in with it — on a second, throwaway client, so the
// session in use is left exactly as it is (no new tokens, no auth event, no
// role refresh). That client keeps nothing: memory only, under its own storage
// key, and the session its sign-in opened is closed again right away.

let verifier: SupabaseClient | null = null;

/** Built once: auth-js warns about every extra client sharing a storage key. */
function verifierClient(): SupabaseClient {
  verifier ??= createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        storageKey: "ac-password-check",
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return verifier;
}

export type PasswordCheck = "ok" | "wrong" | "rate-limited" | "failed";

/**
 * Is `password` the current password of the account `userId`, which signs in
 * with `email`? The id is checked too: the password must open THIS account,
 * not merely some account that has the address.
 */
export async function checkCurrentPassword(
  email: string,
  password: string,
  userId: string,
): Promise<PasswordCheck> {
  const client = verifierClient();
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (!error) {
      // Close the session that check just opened — that one only ("local"),
      // not the one the user is working in.
      await client.auth.signOut({ scope: "local" });
      return data.user?.id === userId ? "ok" : "failed";
    }
    if (isAuthError(error)) {
      if (error.status === 429 || error.code === "over_request_rate_limit") return "rate-limited";
      // Only THIS answer means a wrong password; anything else (network, the
      // service being down…) must not be reported to the user as one.
      if (error.code === "invalid_credentials") return "wrong";
    }
    return "failed";
  } catch {
    return "failed";
  }
}

/**
 * Whether the account has a password at all. One created through Google has
 * none to ask for: its first password is set without one.
 *
 * Supabase does not say it outright, and an account that started with Google
 * keeps "google" as its only provider even once it has a password. So, beyond
 * the providers, two more signs count: the mark this app leaves when it sets a
 * first password (`has_password`), and a session that was itself opened with a
 * password. A Google account given a password some other way, and signed in
 * through Google, is the one case this cannot see.
 */
export function hasPassword(user: User | null, accessToken?: string | null): boolean {
  if (!user) return false;
  const providers = user.app_metadata?.providers;
  if (Array.isArray(providers) && providers.includes("email")) return true;
  if (user.app_metadata?.provider === "email") return true;
  if ((user.identities ?? []).some((identity) => identity.provider === "email")) return true;
  if (user.user_metadata?.has_password === true) return true;
  return signedInWithPassword(accessToken);
}

/** How the session was opened is written in its token (the `amr` claim). */
function signedInWithPassword(accessToken?: string | null): boolean {
  try {
    const payload = accessToken?.split(".")[1];
    if (!payload) return false;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as {
      amr?: unknown;
    };
    return (
      Array.isArray(claims.amr) &&
      claims.amr.some(
        (entry) =>
          entry === "password" || (entry as { method?: unknown } | null)?.method === "password",
      )
    );
  } catch {
    return false;
  }
}
