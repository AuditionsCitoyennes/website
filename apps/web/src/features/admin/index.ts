// The admin area: one page, per-resource subfolders. The "Nouvelle Audition"
// popup is opened from the nav bar on any page, so its state and its loader
// are exported for app/.
export { useCreateAudition } from "./auditions/useCreateAudition";
/** The popup itself, downloaded only for admins (app/AppDialogs.vue). */
export const loadCreateAuditionDialog = () => import("./auditions/CreateAuditionDialog.vue");
export const AdminPage = () => import("./pages/AdminPage.vue");
