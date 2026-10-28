import type { Ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { LocationGroup, PublicTestimony } from "@ac/shared";
import { api } from "@/shared/api/client";

// vue-query keys of the corpus' pipeline (the "Données" switch's corpus and
// comparer, dataSource.ts): the explorer queries them there, and
// app/AppDialogs.vue invalidates them when an audition is created from
// anywhere, with the place reads' (placesKeys).
export const testimoniesKeys = {
  list: ["testimonies"] as const,
  map: ["map"] as const,
};

/** The public corpus. `enabled`: not for the home page's card — it has no
 *  filters and no panel, so nothing there reads the corpus (1.5 MB per visit
 *  saved); fetched once the card becomes the page. */
export function useTestimoniesQuery(enabled: Ref<boolean>) {
  return useQuery({
    queryKey: testimoniesKeys.list,
    queryFn: () => api.get<PublicTestimony[]>("/api/testimonies"),
    enabled,
    // shallow: vue-query wraps data in reactive()+readonly() by default, so every
    // nested object of these bulk payloads becomes a double Proxy and each read in
    // the hierarchy/mesh hot paths pays a trap. Nothing mutates this data.
    shallow: true,
  });
}

/** The map's groups (/api/map): the corpus' pipeline only (the "Données"
 *  switch's corpus and comparer). Placed when written (map phase 1), so one
 *  answer is the map: nothing to poll for. */
export function useMapGroupsQuery() {
  return useQuery({
    queryKey: testimoniesKeys.map,
    queryFn: () => api.get<LocationGroup[]>("/api/map"),
    shallow: true,
  });
}
