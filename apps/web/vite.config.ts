import { defineConfig, loadEnv, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { mapPreloadFiles, mapPreloadScript } from "./src/shared/boot/mapPreloadPlan";

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

// The map page's code asked for from the HTML (shared/boot/mapPreload.ts): the
// built page is told the names of the map page's chunks and stylesheets, in a
// small inline script that asks for them on the map page alone. A build only:
// the dev server has no chunks to name. `testTools`: the script reads the DEV
// switch (a staging build); otherwise it has the default baked in.
function mapPreloadHtml(mode: string): Plugin {
  const testTools = loadEnv(mode, process.cwd(), "VITE_").VITE_APP_ENV === "staging";
  return {
    name: "ac-map-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const chunks = Object.values(ctx.bundle ?? {}).flatMap((c) =>
          c.type === "chunk"
            ? [
                {
                  fileName: c.fileName,
                  isEntry: c.isEntry,
                  facadeModuleId: c.facadeModuleId,
                  imports: c.imports,
                  css: [...(c.viteMetadata?.importedCss ?? [])],
                },
              ]
            : [],
        );
        const script = mapPreloadScript(mapPreloadFiles(chunks), testTools);
        return script ? [{ tag: "script", children: script, injectTo: "head" }] : [];
      },
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  plugins: [vue(), mapPreloadHtml(mode)],
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
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Mapbox GL in a file of its own (mapbox-gl-<hash>.js), apart from
          // the map page's own code: its name changes only when Mapbox's
          // version does, so a returning visitor keeps it in the browser's
          // cache across the site's releases (the files under /assets/ are
          // cached for a year: public/_headers). Still lazy: only the map
          // page's chunks import it.
          // The library's code alone: its stylesheet stays with the map's
          // own (GeoDrillMap.vue imports it), and what it imports (the
          // bundler's helpers) stays in the files the entry already loads —
          // with its dependencies pulled in, the group took Vite's preload
          // helper, and the entry then loaded all of Mapbox on every page.
          groups: [
            {
              name: "mapbox-gl",
              test: /[\\/]node_modules[\\/]mapbox-gl[\\/].*\.js$/,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
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
