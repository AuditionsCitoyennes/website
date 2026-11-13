// When the Supabase client (supabase-js: the sign-in library, about 47 kB
// compressed) is downloaded, compared live in the builds with the testing
// tools (the dev server and staging, __TEST_TOOLS__), kept in localStorage and
// drawn as the DEV dialog's « Connexion » row:
//
// - "demande" (the default): only when the visit may have a signed-in account
//   (a kept session, an email link's or Google's return: authPresence.ts), or
//   when a page asks for it (the sign-in page, the password page, the admin
//   area). Every other visitor's pages start without it.
// - "demarrage": as before, on every page at boot (main.ts asks for it at
//   once, before the app is mounted).
//
// Read once per page load: switching reloads the page. Production has neither
// key nor switch: DEFAULT_AUTH_CLIENT.
//
// Pure apart from the switch's read: loadable under node (authPresence.test.ts).

export type AuthClient = "demande" | "demarrage";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_AUTH_CLIENT: AuthClient = "demande";

export const AUTH_CLIENTS: readonly AuthClient[] = ["demande", "demarrage"];

/** The kept mode, else the default (garbage or blocked storage too). */
export function storedAuthClient(): AuthClient {
  try {
    const raw = localStorage.getItem("ac:auth-client");
    return (AUTH_CLIENTS as readonly string[]).includes(raw ?? "")
      ? (raw as AuthClient)
      : DEFAULT_AUTH_CLIENT;
  } catch {
    return DEFAULT_AUTH_CLIENT;
  }
}

/** This page load's mode. */
export const authClient: AuthClient = __TEST_TOOLS__ ? storedAuthClient() : DEFAULT_AUTH_CLIENT;

/** Another mode: kept, and the page loaded again with it. */
export function setAuthClient(mode: AuthClient) {
  if (!__TEST_TOOLS__ || mode === authClient) return;
  try {
    localStorage.setItem("ac:auth-client", mode);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}
