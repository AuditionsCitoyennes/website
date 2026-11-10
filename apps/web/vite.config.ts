import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

// The outline build the site reads (features/geo-nav/data/useOutlineFiles):
// the lock's, read once at start, so a lock bump needs a dev-server restart.
// An unreadable lock gives "", and the page falls back to the API's outlines
// rather than the build breaking.
function outlinesBuild(): string {
  try {
    const lock = readFileSync(
      fileURLToPath(new URL("./outlines.lock.json", import.meta.url)),
      "utf8",
    );
    const build = (JSON.parse(lock) as { build?: unknown }).build;
    return typeof build === "string" ? build : "";
  } catch {
    return "";
  }
}

export default defineConfig(({ command, mode }) => ({
  plugins: [vue()],
  define: {
    // Every component is `<script setup>`, so the Options API runtime is dead
    // weight — flagging it lets the minifier drop that branch of Vue.
    __VUE_OPTIONS_API__: "false",
    // The testing tools — the outbox (features/outbox), the testing options
    // menu (features/temoignages/DevOptionsMenu.vue): in local development,
    // and in a build with VITE_APP_ENV=staging. Any other build has none of
    // them, not a byte.
    __TEST_TOOLS__: JSON.stringify(
      command === "serve" || loadEnv(mode, process.cwd(), "VITE_").VITE_APP_ENV === "staging",
    ),
    // The Analyses (features/analyses: the panel's toggle, the plates and slabs
    // around the plateau): in local development, and in a build with
    // VITE_ANALYSES=on (staging). Any other build — production's first release —
    // has none of their drawing code (a few inert hooks and the framing
    // settings stay: docs/feature-flags.md).
    __ANALYSES__: JSON.stringify(
      command === "serve" || loadEnv(mode, process.cwd(), "VITE_").VITE_ANALYSES === "on",
    ),
    __OUTLINES_BUILD__: JSON.stringify(outlinesBuild()),
  },
  // The app's Web Workers are modules (`new Worker(url, { type: "module" })`,
  // map/relief/demClient.ts): their bundles must be ES too (Vite's default is
  // iife). Only a build that emits a worker sees it.
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Bind IPv4 localhost explicitly. Vite's default ("localhost") bound to
    // IPv6 [::1] only on this machine, but `localhost` resolves to 127.0.0.1
    // first — so the browser hit IPv4 with nothing listening.
    host: "127.0.0.1",
    // Honor a runner-assigned port (e.g. preview tooling) — 5173 otherwise.
    port: Number(process.env.PORT) || 5173,
  },
}));
