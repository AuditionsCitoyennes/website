import { createRouter, createWebHistory } from "vue-router";
import { routes } from "./routes";
import { ROUTE } from "@/shared/routes";
import { endHomeShell } from "@/shared/boot/homeBoot";

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    // A section of the page (the home page's, say): under the sticky header.
    if (to.hash) return { el: to.hash, top: 64 };
    return { top: 0 };
  },
  routes,
});

// The HTML paints "/" in the hero's ground until the home page mounts
// (shared/boot/homeBoot.ts). A visit to "/" that ends on another page (a
// redirect, a navigation before the home page is in) drops that ground, so
// the other page is never painted in it while its code comes.
router.afterEach((to) => {
  if (to.name !== ROUTE.home.name) endHomeShell();
});
