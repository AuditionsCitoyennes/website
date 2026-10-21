// The visitor's own testimony: the "Témoigner" popup and the verification page.
export { useSubmitTestimony } from "./useSubmitTestimony";
/** The popup itself, downloaded only once it is first asked for (app/AppDialogs.vue). */
export const loadSubmitTestimonyDialog = () => import("./SubmitTestimonyDialog.vue");
export const VerifyTestimonyPage = () => import("./pages/VerifyTestimonyPage.vue");
