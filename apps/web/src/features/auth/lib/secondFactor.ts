// The second factor of an account (a code from an authenticator app, TOTP):
// whether a session still owes one. Decided from the session alone (the level
// its token says it reached, the account's factors as the session lists
// them): no request, so the pages can ask at any time. Pure: loadable under
// node (secondFactor.test.ts).

import { tokenClaims } from "./tokenClaims";

/** What the decision reads of a session (supabase-js's Session has it). */
export interface SecondFactorSession {
  access_token: string;
  user: { factors?: { status: string }[] | null };
}

/**
 * Whether the session's account has a confirmed second factor that the
 * session has not given yet. False when nobody is signed in.
 */
export function owesSecondFactor(session: SecondFactorSession | null | undefined): boolean {
  if (!session) return false;
  const confirmed = session.user.factors?.some((factor) => factor.status === "verified") ?? false;
  return confirmed && tokenClaims(session.access_token)?.aal !== "aal2";
}
