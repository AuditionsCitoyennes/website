// First, before the router's module reads the address: a return from Supabase
// Auth is taken out of it (shared/api/authArrival.ts).
import { authArrival } from "./shared/api/authArrival";
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
import { glassAttribute } from "./shared/device/glassSwitch";
import { onSecondFactorWanted } from "./shared/api/client";
import { ROUTE } from "./shared/routes";
import { acceptsAuthReturn, consumeAuthReturn } from "./features/auth";

// The glass blurs on a strong device only (shared/device/glassSwitch.ts).
const glassMode = glassAttribute(deviceTier());
if (glassMode) document.documentElement.dataset.glass = glassMode;

// --- iOS Safari viewport height fix (exposes --app-height) ---
const setAppHeight = () => {
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
};
setAppHeight();
window.addEventListener("resize", setAppHeight);

const app = createApp(App);
app.use(createPinia());

// The API refused an admin route for want of a second factor: the page that
// gives one (features/auth, MfaPage).
onSecondFactorWanted(() => {
  if (router.currentRoute.value.name === ROUTE.secondFactor.name) return;
  void router.push({ name: ROUTE.secondFactor.name, query: { requise: "1" } });
});

const start = () => {
  app.use(router);
  app.use(VueQueryPlugin, vueQueryOptions);
  app.mount("#app");
};

// A return from Supabase Auth (an email link, Google) is read on the pages
// that accept one, and settled before they mount, so that each finds the
// session as it will stay; anywhere else it was dropped with the address.
// A slow Auth does not hold the site back for long: the pages then show
// their own loader until the return is settled.
const RETURN_WAIT_MS = 10_000;
if (authArrival && acceptsAuthReturn(authArrival.path)) {
  const settled = consumeAuthReturn(authArrival).catch(() => undefined);
  const waited = new Promise<void>((resolve) => window.setTimeout(resolve, RETURN_WAIT_MS));
  void Promise.race([settled, waited]).then(start);
} else {
  start();
}
