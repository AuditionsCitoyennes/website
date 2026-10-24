import { supabase } from "@/shared/api/supabase";
import { api } from "@/shared/api/client";

// What the account section asks of the two services behind an account: the
// name and the email are Supabase Auth's (the account itself); deleting the
// account is the API's (/api/me), which takes its roles with it. The password
// change has its own rules and calls: usePasswordChange.ts.

/** A new display name, in the account's metadata. */
export function setUsername(username: string) {
  return supabase.auth.updateUser({ data: { username } });
}

/** A new address: Supabase sends a confirmation email to it. */
export function setEmail(email: string) {
  return supabase.auth.updateUser({ email });
}

/** The signed-in account deleted, with its roles. */
export function deleteAccount() {
  return api.del("/api/me");
}
