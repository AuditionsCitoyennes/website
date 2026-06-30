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
  // Désactive les règles de mise en forme qui entrent en conflit avec Prettier
  skipFormatting,
);
