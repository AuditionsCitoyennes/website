// The signed-in account's tools, for the admin area: imported as
// "@/features/auth/account" rather than through the barrel, so that they stay
// in the admin chunks and out of the entry (see ./index.ts).
export { useIdleTimeout } from "./composables/useIdleTimeout";
export { checkCurrentPassword, hasPassword } from "./reauth";
export { passwordSchema, PASSWORD_REQUIREMENTS } from "./lib/password";
export { default as UsernamePromptDialog } from "./components/UsernamePromptDialog.vue";
