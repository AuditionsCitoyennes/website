// The return from Supabase Auth this page load arrived with, if any, taken out
// of the address as this module is evaluated: the tokens of an email link or
// of the Google sign-in then stay neither in the address bar nor in the tab's
// history (« Back » shows the clean address), on whatever page the link
// landed.
//
// main.ts imports this module FIRST: the router reads the address when it is
// created, and would write the fragment back with its first navigation.
// What the return brought is kept here, in memory, for the pages that accept
// one (features/auth/returnArrival.ts); everywhere else it is dropped.

import { readAuthReturn, type AuthReturn } from "./authPresence";

export interface AuthArrival {
  ret: AuthReturn;
  /** The page it landed on. */
  path: string;
}

function take(): AuthArrival | null {
  const { ret, search, hash } = readAuthReturn(window.location.search, window.location.hash);
  if (!ret) return null;
  const path = window.location.pathname;
  window.history.replaceState(window.history.state, "", `${path}${search}${hash}`);
  return { ret, path };
}

export const authArrival: AuthArrival | null = take();
