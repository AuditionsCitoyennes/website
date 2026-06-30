import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 };
  },
  routes: [
    { path: "/", name: "home", component: () => import("@/pages/Landing.vue") },
    {
      path: "/temoignages",
      name: "temoignages",
      component: () => import("@/pages/Temoignages.vue"),
    },
    {
      path: "/analyses",
      name: "analyses",
      alias: ["/analyse"],
      component: () => import("@/pages/Analyses.vue"),
    },
    {
      path: "/audition/:id",
      name: "audition-detail",
      component: () => import("@/pages/AuditionDetail.vue"),
    },
    {
      path: "/participer",
      name: "participer",
      component: () => import("@/pages/Participer.vue"),
    },
    { path: "/auth", name: "auth", component: () => import("@/pages/Auth.vue") },
    { path: "/admin", name: "admin", component: () => import("@/pages/Admin.vue") },
    {
      path: "/verifier/:token",
      name: "verify-testimony",
      component: () => import("@/pages/VerifyTestimony.vue"),
    },
    {
      path: "/reset-password",
      name: "reset-password",
      component: () => import("@/pages/ResetPassword.vue"),
    },
    {
      path: "/:pathMatch(.*)*",
      name: "not-found",
      component: () => import("@/pages/NotFound.vue"),
    },
  ],
});
