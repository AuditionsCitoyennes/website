// What the site does with a return from Supabase Auth (an email link, the
// Google sign-in) that landed on one of the pages that accept one: the
// decision, apart from the client and the screen (../returnArrival.ts gives
// both), so that it runs under node (authReturn.test.ts).
//
// A return never replaces another account's session without the visitor
// saying so: a link opened in a browser where somebody else is signed in is
// first resolved to its account, by Auth, and the visitor is asked. Tokens
// Auth does not know leave the signed-in session as it is.

import type { AuthReturn } from "../../../shared/api/authPresence";
import { ROUTE } from "../../../shared/routes";

/** The pages a return is read on; on any other it is dropped. */
const RETURN_PAGES: string[] = [ROUTE.admin.path, ROUTE.auth.path, ROUTE.resetPassword.path];

/** A path as the router matches it: without its trailing slashes. */
const pageOf = (path: string) => path.replace(/\/+$/, "") || "/";

export function acceptsAuthReturn(path: string): boolean {
  return RETURN_PAGES.includes(pageOf(path));
}

export function isResetPage(path: string): boolean {
  return pageOf(path) === ROUTE.resetPassword.path;
}

export interface Account {
  id: string;
  email: string | null;
}

/** The client and the screen, as the decision needs them. */
export interface ReturnDeps {
  /** The account signed in in this browser, if any. */
  current(): Promise<Account | null>;
  /** The account an access token belongs to, as Auth says it, without
   *  touching the kept session; null when Auth refuses the token. Throws when
   *  Auth cannot be asked. */
  whoIs(accessToken: string): Promise<Account | null>;
  /** Asks whether to leave `current` for `incoming`. */
  confirmSwitch(current: Account, incoming: Account): boolean;
  /** Closes the session in use. */
  leave(): Promise<void>;
  /** Keeps the session of the two tokens (and nothing else of the return);
   *  null when Auth refuses them. */
  store(accessToken: string, refreshToken: string): Promise<Account | null>;
}

export type Settled =
  /** The return's session is the browser's now; `type` is what the link was for. */
  | { outcome: "signed-in"; account: Account; type: string | null }
  /** Another account was signed in and the visitor kept it. */
  | { outcome: "kept"; account: Account }
  /** Auth's refusal in the address, or tokens Auth does not know. */
  | { outcome: "refused" }
  /** The first of an email change's two confirmations. */
  | { outcome: "notice" }
  /** Auth could not be asked. */
  | { outcome: "unreachable" }
  | { outcome: "nothing" };

export async function settleAuthReturn(ret: AuthReturn, deps: ReturnDeps): Promise<Settled> {
  if (ret.kind === "unused") return { outcome: "nothing" };
  if (ret.kind === "notice") return { outcome: "notice" };
  if (ret.kind === "error") return { outcome: "refused" };
  try {
    const current = await deps.current();
    if (current) {
      const incoming = await deps.whoIs(ret.accessToken);
      if (!incoming) return { outcome: "refused" };
      if (incoming.id !== current.id) {
        if (!deps.confirmSwitch(current, incoming)) return { outcome: "kept", account: current };
        await deps.leave();
      }
    }
    const account = await deps.store(ret.accessToken, ret.refreshToken);
    return account ? { outcome: "signed-in", account, type: ret.type } : { outcome: "refused" };
  } catch {
    return { outcome: "unreachable" };
  }
}
