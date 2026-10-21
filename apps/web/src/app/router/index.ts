import { createRouter, createWebHistory } from "vue-router";
import { routes } from "./routes";

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
