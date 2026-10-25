import pluginVue from "eslint-plugin-vue";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import skipFormatting from "@vue/eslint-config-prettier/skip-formatting";

// The entries a feature exposes beside its barrel: a pure or type-only slice
// that another feature may import without pulling the feature's components
// into its chunk. Everything else of a feature is reached through its barrel.
const SECONDARY_ENTRIES = {
  map: ["lib", "types", "events"],
  auth: ["account"],
};

// One ESLint config object per feature: what it may import, as listed in
// `layers` (name → the features below it). A feature not listed imports no
// other feature.
function featureBoundaries(layers) {
  const names = Object.keys(layers);
  return names.map((name) => {
    const allowed = new Set(layers[name]);
    // The barrel of every feature it may not import, and the deep paths of
    // every feature (its own included — a feature reaches its own files by
    // relative path), minus the secondary entries of the features it may import.
    const group = [
      "@/app",
      ...names
        .filter((other) => other !== name && !allowed.has(other))
        .map((other) => `@/features/${other}`),
      "@/features/*/*",
      ...[...allowed].flatMap((other) =>
        (SECONDARY_ENTRIES[other] ?? []).map((entry) => `!@/features/${other}/${entry}`),
      ),
    ];
    return {
      name: `app/feature-boundary-${name}`,
      files: [`apps/web/src/features/${name}/**/*.{ts,mts,vue}`],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group,
                message: `features/${name} imports shared/, ${
                  allowed.size ? `the barrel of ${[...allowed].join(", ")}` : "no other feature"
                }, and its own files by relative path.`,
              },
            ],
          },
        ],
      },
    };
  });
}

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
    // (docs/architecture-proposal-2026-10-20.md, rule 3).
    name: "app/shared-import-boundary",
    files: ["apps/web/src/shared/**/*.{ts,mts,vue}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/features", "@/app"],
              message: "shared/ imports only shared/ and @ac/shared.",
            },
          ],
        },
      ],
    },
  },
  // features/ form a one-way layering (rule 2): a feature imports shared/, the
  // features listed under it here — through their barrel (@/features/<name>)
  // or one of the few entries a feature declares beside it — and its own
  // files by relative path. Nothing imports app/ but main.ts.
  ...featureBoundaries({
    // geo → map → analyses → geo-nav → temoignages → map-stage → app
    geo: [],
    map: ["geo"],
    analyses: ["geo", "map"],
    "geo-nav": ["geo", "map", "analyses", "filters"],
    temoignages: ["geo-nav", "analyses", "filters"],
    "map-stage": ["temoignages", "map"],
    // beside that chain
    filters: [],
    auth: [],
    testify: [],
    audition: [],
    outbox: ["auth"],
    home: ["map-stage", "auth", "testify"],
    admin: ["auth", "filters"],
  }),
  // Désactive les règles de mise en forme qui entrent en conflit avec Prettier
  skipFormatting,
);
