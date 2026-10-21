// The auth feature: the session store and the sign-in / sign-up and password
// pages. The pages are loaders, so each stays the chunk the router downloads
// on its own. What the admin area uses of the signed-in account is a second
// entry, ./account (as map/lib in the proposal): the shell imports this barrel
// for the store, and must not download the account dialogs with it.
export { useAuthStore } from "./store";
export const AuthPage = () => import("./pages/AuthPage.vue");
export const ResetPasswordPage = () => import("./pages/ResetPasswordPage.vue");
