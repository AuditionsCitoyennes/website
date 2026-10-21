import pluginVue from "eslint-plugin-vue";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import skipFormatting from "@vue/eslint-config-prettier/skip-formatting";

export default defineConfigWithVueTs(
  {
    name: "app/files-to-lint",
    files: ["**/*.{ts,mts,vue}"],
  },
  {
    name: "app/files-to-ignore",
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      // Deno edge functions — différent runtime (imports URL, globals Deno)
      "supabase/**",
    ],
  },
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,
  {
    // Les composants de route (pages) portent par nature un nom en un seul mot
    name: "app/pages-single-word-names",
    files: ["**/pages/**/*.vue"],
    rules: { "vue/multi-word-component-names": "off" },
  },
  {
    // shared/ is feature-agnostic: it imports only shared/ and @ac/shared
    // (docs/architecture-proposal-2026-10-20.md, rule 3). A warning while the
    // layout is being migrated; an error once the last step lands (step 14).
    name: "app/shared-import-boundary",
    files: ["apps/web/src/shared/**/*.{ts,mts,vue}"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: [
                "@/components",
                "@/composables",
                "@/lib",
                "@/stores",
                "@/pages",
                "@/features",
                "@/app",
              ],
              message: "shared/ imports only shared/ and @ac/shared.",
            },
          ],
        },
      ],
    },
  },
  // Désactive les règles de mise en forme qui entrent en conflit avec Prettier
  skipFormatting,
);
