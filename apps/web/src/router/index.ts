import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    // A section of the page (the home page's, say): under the sticky header.
    if (to.hash) return { el: to.hash, top: 64 };
    return { top: 0 };
  },
  routes: [
    // `bleed`: on phones the page runs under the floating header (its photo,
    // its map) instead of leaving it room at the top — see App.vue.
    {
      path: "/",
      name: "home",
      component: () => import("@/pages/Landing.vue"),
      meta: { bleed: true },
    },
    {
      path: "/temoignages",
      name: "temoignages",
      // Only a place for the map, which lives above the pages (MapStage).
      component: () => import("@/pages/TemoignagesPage.vue"),
      meta: { bleed: true },
    },
    // The page is gone: its analyses are drawn on the map now, around the
    // territory it shows. Old links open the map with them on.
    {
      path: "/analyses",
      redirect: (to) => ({ name: "temoignages", query: { ...to.query, analyses: "1" } }),
    },
    {
      path: "/analyse",
      redirect: (to) => ({ name: "temoignages", query: { ...to.query, analyses: "1" } }),
    },
    {
      path: "/audition/:id",
      name: "audition-detail",
      component: () => import("@/pages/AuditionDetail.vue"),
    },
    // The page is gone: what it said lives on the home page now. Old links
    // land on that part of it.
    { path: "/participer", redirect: { path: "/", hash: "#auditions-publiques" } },
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
