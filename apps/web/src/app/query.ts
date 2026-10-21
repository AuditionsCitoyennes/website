import type { VueQueryPluginOptions } from "@tanstack/vue-query";

// Public data (testimonies, auditions, map) is shared and barely changes, so
// treat it as fresh for 5 min and don't refetch on every window focus — both
// were silently re-pulling the full corpus from Supabase on each mount/focus.
// GeoNav opts into `staleTime: Infinity` per-query; the map poll uses
// `refetchInterval`, which is independent of these defaults.
export const vueQueryOptions: VueQueryPluginOptions = {
  queryClientConfig: {
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  },
};
