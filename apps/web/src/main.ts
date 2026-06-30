import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { router } from "./router";
import "mapbox-gl/dist/mapbox-gl.css";
import "./styles/global.css";

// Theme bootstrap lives in composables/useTheme.ts (module scope) so the
// reactive ref and the <html> class share one initialization.
import "./composables/useTheme";

// --- iOS Safari viewport height fix (exposes --app-height) ---
const setAppHeight = () => {
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
};
setAppHeight();
window.addEventListener("resize", setAppHeight);

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(VueQueryPlugin);
app.mount("#app");
