import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { router } from "./app/router";
import { vueQueryOptions } from "./app/query";
import "./shared/styles/index.css";

// Theme bootstrap lives in shared/ui/theme/useTheme.ts (module scope) so the
// reactive ref and the <html> class share one initialization.
import "./shared/ui/theme/useTheme";
import { deviceTier } from "./shared/device/deviceTier";
import { glass, glassAttribute } from "./shared/device/glassSwitch";
import { isAuthReturn } from "./shared/api/authPresence";
import { authClient } from "./shared/api/authClientSwitch";
import { loadSupabase } from "./shared/api/supabaseLazy";

// The glass blurs on a strong device only (shared/device/glassSwitch.ts).
const glassMode = glassAttribute(glass, deviceTier());
if (glassMode) document.documentElement.dataset.glass = glassMode;

// --- iOS Safari viewport height fix (exposes --app-height) ---
const setAppHeight = () => {
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
};
setAppHeight();
window.addEventListener("resize", setAppHeight);

const app = createApp(App);
app.use(createPinia());

// The Supabase client is downloaded when a visit needs it (shared/api/
// supabaseLazy.ts). A return from Supabase Auth (an email link, Google) has
// its session in the address: the client is made before the router may move
// away from it, as when it was part of the first files. The DEV choice
// « Au démarrage » asks for it at boot on every page, as before.
const start = () => {
  app.use(router);
  app.use(VueQueryPlugin, vueQueryOptions);
  app.mount("#app");
};
if (isAuthReturn(window.location.search, window.location.hash)) {
  void loadSupabase().then(start, start);
} else {
  if (authClient === "demarrage") void loadSupabase();
  start();
}
