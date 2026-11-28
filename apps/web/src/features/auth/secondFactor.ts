// The second factor of an account (a code from an authenticator app, TOTP):
// whether this session still owes one, and the route guard that asks for it
// before the admin area opens. No import of the client's module: this is part
// of the first files (the barrel), the client comes through supabaseLazy.ts.

import type { NavigationGuardWithThis } from "vue-router";
import { clientIfSignedIn } from "@/shared/api/supabaseLazy";
import { ROUTE } from "@/shared/routes";

/**
 * Whether the signed-in account has a second factor that this session has not
 * given yet. Read from the session the browser keeps (its token's level, the
 * account's factors as of its sign-in): no request. False when nobody is
 * signed in.
 */
export async function secondFactorDue(): Promise<boolean> {
  const client = await clientIfSignedIn();
  if (!client) return false;
  const { data } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  return data?.nextLevel === "aal2" && data.currentLevel !== "aal2";
}

/** Before the admin area: a session that owes its second factor goes to the
 *  page that asks for it. */
export const secondFactorGate: NavigationGuardWithThis<undefined> = async () =>
  (await secondFactorDue()) ? { name: ROUTE.secondFactor.name } : true;
