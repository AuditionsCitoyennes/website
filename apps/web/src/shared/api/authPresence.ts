// What the site knows of a signed-in account before the Supabase client is
// there: the client (supabase-js, about 47 kB compressed) is downloaded only
// for a visit that may be signed in, or when a page that signs in asks for it
// (shared/api/supabaseLazy.ts).
//
// - A visit may be signed in when the browser keeps a Supabase session, or a
//   sign-in under way: a localStorage key `sb-<project>-auth-token` (the
//   session) or `sb-<project>-auth-token-code-verifier`, as supabase-js names
//   them.
// - A return from Supabase Auth (an email link: sign-up confirmation, password
//   recovery, email change; or the Google sign-in) carries its session, or its
//   error, in the address: `#access_token=…&refresh_token=…&type=recovery`,
//   `#error_description=…`, `?code=…`. The site reads it itself, once, as the
//   page loads (readAuthReturn here, shared/api/authArrival.ts), and takes it
//   out of the address: the client never reads an address.
//
// Pure: loadable under node (authPresence.test.ts).

/** A localStorage key supabase-js keeps a session, or a sign-in under way, in. */
export function isAuthStorageKey(key: string | null | undefined): boolean {
  return !!key && /^sb-.+-auth-token(-code-verifier)?$/.test(key);
}

/** Whether the visit may have a signed-in account: a kept session or sign-in
 *  (`keys`: localStorage's keys). */
export function mayHaveSession(keys: Iterable<string>): boolean {
  for (const k of keys) if (isAuthStorageKey(k)) return true;
  return false;
}

/** What a return from Supabase Auth brought. */
export type AuthReturn =
  /** A session: the two tokens, and what the link was for (`type`: signup,
   *  recovery, email_change…; null after a provider sign-in). */
  | { kind: "session"; accessToken: string; refreshToken: string; type: string | null }
  /** A refusal: an expired or used link, a sign-in the provider did not
   *  complete. `code` is Auth's error code, when it gave one. */
  | { kind: "error"; code: string | null }
  /** The first of the two confirmations of an email change: nothing to store. */
  | { kind: "notice" }
  /** Auth parameters the site does nothing with (a `code`, a lone token). */
  | { kind: "unused" };

/** The parameters that make a fragment, or a query, a return from Auth. */
const FRAGMENT_MARKS = [
  "access_token",
  "refresh_token",
  "provider_token",
  "provider_refresh_token",
  "error_description",
  "error_code",
  "token_hash",
  "message",
];
const QUERY_MARKS = [
  "code",
  "access_token",
  "refresh_token",
  "provider_token",
  "provider_refresh_token",
  "error_description",
  "error_code",
  "token_hash",
];
/** What travels with them in a query, and leaves with them. */
const QUERY_COMPANIONS = ["error", "type", "expires_in", "expires_at", "token_type"];

/** An address read for a return from Auth: what it brought (null: nothing),
 *  and its query and fragment without it. */
export interface AddressRead {
  ret: AuthReturn | null;
  search: string;
  hash: string;
}

/**
 * Reads an address (its query and its fragment) for a return from Supabase
 * Auth. A fragment that is one is dropped whole; a query loses the Auth
 * parameters and keeps the others (`?tab=inscription`). A session is only ever
 * read from the fragment, where Auth puts it.
 */
export function readAuthReturn(search: string, hash: string): AddressRead {
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const query = new URLSearchParams(search.replace(/^\?/, ""));
  const inFragment = FRAGMENT_MARKS.some((p) => fragment.has(p));
  const inQuery = QUERY_MARKS.some((p) => query.has(p));
  if (!inFragment && !inQuery) return { ret: null, search, hash };

  let ret: AuthReturn = { kind: "unused" };
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (accessToken && refreshToken) {
    ret = { kind: "session", accessToken, refreshToken, type: fragment.get("type") };
  } else if (["error_description", "error_code"].some((p) => fragment.has(p) || query.has(p))) {
    ret = {
      kind: "error",
      code:
        fragment.get("error_code") ??
        query.get("error_code") ??
        fragment.get("error") ??
        query.get("error"),
    };
  } else if (fragment.has("message") && !inQuery) {
    ret = { kind: "notice" };
  }

  let cleanSearch = search;
  if (inQuery) {
    for (const p of [...QUERY_MARKS, ...QUERY_COMPANIONS]) query.delete(p);
    const rest = query.toString();
    cleanSearch = rest ? `?${rest}` : "";
  }
  return { ret, search: cleanSearch, hash: inFragment ? "" : hash };
}
