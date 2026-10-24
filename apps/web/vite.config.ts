import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ command, mode }) => ({
  plugins: [vue()],
  define: {
    // Every component is `<script setup>`, so the Options API runtime is dead
    // weight — flagging it lets the minifier drop that branch of Vue.
    __VUE_OPTIONS_API__: "false",
    // The testing tools — the outbox (features/outbox), the analyses' DEV
    // switches (lib/slabDev): in local development, and in a build with
    // VITE_APP_ENV=staging. Any other build has none of them, not a byte.
    __TEST_TOOLS__: JSON.stringify(
      command === "serve" || loadEnv(mode, process.cwd(), "VITE_").VITE_APP_ENV === "staging",
    ),
  },
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
