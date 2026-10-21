import type { RouteRecordRaw } from "vue-router";
import { ROUTE } from "@/shared/routes";

declare module "vue-router" {
  interface RouteMeta {
    /** On phones the page runs under the floating header (its photo, its map)
     *  instead of leaving it room at the top — see App.vue. */
    bleed?: boolean;
  }
}

export const routes: RouteRecordRaw[] = [
  {
    path: ROUTE.home.path,
    name: ROUTE.home.name,
    component: () => import("@/pages/Landing.vue"),
    meta: { bleed: true },
  },
  {
    path: ROUTE.temoignages.path,
    name: ROUTE.temoignages.name,
    // Only a place for the map, which lives above the pages (MapStage).
    component: () => import("@/pages/TemoignagesPage.vue"),
    meta: { bleed: true },
  },
  // The page is gone: its analyses are drawn on the map now, around the
  // territory it shows. Old links open the map with them on.
  {
    path: "/analyses",
    redirect: (to) => ({ name: ROUTE.temoignages.name, query: { ...to.query, analyses: "1" } }),
  },
  {
    path: "/analyse",
    redirect: (to) => ({ name: ROUTE.temoignages.name, query: { ...to.query, analyses: "1" } }),
  },
  {
    path: ROUTE.auditionDetail.path,
    name: ROUTE.auditionDetail.name,
    component: () => import("@/pages/AuditionDetail.vue"),
  },
  // The page is gone: what it said lives on the home page now. Old links
  // land on that part of it.
  { path: "/participer", redirect: { path: ROUTE.home.path, hash: "#auditions-publiques" } },
  { path: ROUTE.auth.path, name: ROUTE.auth.name, component: () => import("@/pages/Auth.vue") },
  { path: ROUTE.admin.path, name: ROUTE.admin.name, component: () => import("@/pages/Admin.vue") },
  {
    path: ROUTE.verifyTestimony.path,
    name: ROUTE.verifyTestimony.name,
    component: () => import("@/pages/VerifyTestimony.vue"),
  },
  {
    path: ROUTE.resetPassword.path,
    name: ROUTE.resetPassword.name,
    component: () => import("@/pages/ResetPassword.vue"),
  },
  {
    path: ROUTE.notFound.path,
    name: ROUTE.notFound.name,
    component: () => import("@/app/NotFoundPage.vue"),
  },
];
