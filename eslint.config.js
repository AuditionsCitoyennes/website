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
  {
    // features/ reach the legacy flat folders through nothing: what a feature
    // needs is in shared/, in another feature's barrel, or moved with it; and
    // nothing imports app/ except main.ts (rules 1 and 3). A warning while the
    // layout is being migrated (the giants still split, steps 10 to 13); an
    // error once the last step lands (step 14).
    name: "app/features-import-boundary",
    files: ["apps/web/src/features/**/*.{ts,mts,vue}"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["@/components", "@/composables", "@/lib", "@/stores", "@/pages", "@/app"],
              message:
                "features/ import shared/, another feature's barrel (@/features/<name>) or their own files.",
            },
          ],
        },
      ],
    },
  },
  // Désactive les règles de mise en forme qui entrent en conflit avec Prettier
  skipFormatting,
);
