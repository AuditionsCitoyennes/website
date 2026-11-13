// Whether this visit may have a signed-in account, without the Supabase
// client: the client (supabase-js, about 47 kB compressed) is downloaded only
// when the answer is yes, or when a page that signs in asks for it
// (shared/api/supabaseLazy.ts).
//
// Yes when:
// - the browser keeps a Supabase session, or a sign-in under way: a
//   localStorage key `sb-<project>-auth-token` (the session) or
//   `sb-<project>-auth-token-code-verifier` (a PKCE sign-in waiting for its
//   return), as supabase-js names them;
// - the address is a return from Supabase Auth: an email link (sign-up
//   confirmation, magic link, password recovery) or the Google sign-in,
//   which carry the session or an error in the fragment
//   (#access_token=…&type=recovery, #error_description=…) or, with PKCE, a
//   `code` in the query. The client reads them when it is made
//   (detectSessionInUrl), so it must be made on such a page load.
//
// Pure: loadable under node (authPresence.test.ts).

/** A localStorage key supabase-js keeps a session, or a sign-in under way, in. */
export function isAuthStorageKey(key: string | null | undefined): boolean {
  return !!key && /^sb-.+-auth-token(-code-verifier)?$/.test(key);
}

/** The parameters of an auth return, in the fragment or the query. */
const RETURN_PARAMS = ["access_token", "refresh_token", "error_description", "token_hash"];

/** Whether an address (its query and its fragment) is a return from Supabase Auth. */
export function isAuthReturn(search: string, hash: string): boolean {
  const read = (s: string) => new URLSearchParams(s.replace(/^[?#]/, ""));
  const query = read(search);
  const fragment = read(hash);
  if (RETURN_PARAMS.some((p) => fragment.has(p) || query.has(p))) return true;
  // PKCE: the code in the query, the verifier kept by the page that left.
  return query.has("code");
}

/** Whether the visit may have a signed-in account: a kept session or sign-in
 *  (`keys`: localStorage's keys), or an auth return in the address. */
export function mayHaveSession(keys: Iterable<string>, search: string, hash: string): boolean {
  for (const k of keys) if (isAuthStorageKey(k)) return true;
  return isAuthReturn(search, hash);
}
