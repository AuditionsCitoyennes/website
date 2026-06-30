import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue()],
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
    port: 5173,
  },
});
