import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin, type VueQueryPluginOptions } from "@tanstack/vue-query";
import App from "./App.vue";
import { router } from "./router";
import "mapbox-gl/dist/mapbox-gl.css";
import "./shared/styles/index.css";

// Theme bootstrap lives in shared/ui/theme/useTheme.ts (module scope) so the
// reactive ref and the <html> class share one initialization.
import "./shared/ui/theme/useTheme";

// --- iOS Safari viewport height fix (exposes --app-height) ---
const setAppHeight = () => {
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
};
setAppHeight();
window.addEventListener("resize", setAppHeight);

// Public data (testimonies, auditions, map) is shared and barely changes, so
// treat it as fresh for 5 min and don't refetch on every window focus — both
// were silently re-pulling the full corpus from Supabase on each mount/focus.
// GeoNav opts into `staleTime: Infinity` per-query; the map poll uses
// `refetchInterval`, which is independent of these defaults.
const vueQueryOptions: VueQueryPluginOptions = {
  queryClientConfig: {
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  },
};

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(VueQueryPlugin, vueQueryOptions);
app.mount("#app");
