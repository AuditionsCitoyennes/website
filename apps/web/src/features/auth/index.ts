// The auth feature: the session store and the sign-in / sign-up, password and
// second-factor pages. The pages are loaders, so each stays the chunk the
// router downloads on its own. What the admin area uses of the signed-in
// account is a second entry, ./account (as map/lib in the proposal): the shell
// imports this barrel for the store, and must not download the account dialogs
// with it.
import type { AuthArrival } from "@/shared/api/authArrival";

export { useAuthStore } from "./store";
export { secondFactorGate } from "./secondFactor";
export { acceptsAuthReturn } from "./lib/authReturn";
export const AuthPage = () => import("./pages/AuthPage.vue");
export const ResetPasswordPage = () => import("./pages/ResetPasswordPage.vue");
export const MfaPage = () => import("./pages/MfaPage.vue");
/** The return this page load arrived with, settled (./returnArrival.ts). */
export const consumeAuthReturn = (arrival: AuthArrival) =>
  import("./returnArrival").then((m) => m.consumeAuthReturn(arrival));
