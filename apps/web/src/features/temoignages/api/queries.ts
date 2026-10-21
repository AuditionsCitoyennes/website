import type { Ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { LocationGroup, PublicTestimony } from "@ac/shared";
import { api } from "@/shared/api/client";

// vue-query keys of the public data the whole site shares: the explorer
// queries them, and app/AppDialogs.vue invalidates them when an audition is
// created from anywhere.
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

/** Map groups are server-side geocoded + cached; poll until the count
 *  stabilises (the warm pass resolves any not-yet-cached locations). */
export function useMapGroupsQuery() {
  let mapStableTicks = 0;
  let mapLastLen = -1;

  return useQuery({
    queryKey: testimoniesKeys.map,
    queryFn: () => api.get<LocationGroup[]>("/api/map"),
    refetchInterval: (query) => {
      const len = query.state.data?.length ?? -1;
      if (len === mapLastLen) mapStableTicks += 1;
      else {
        mapStableTicks = 0;
        mapLastLen = len;
      }
      return mapStableTicks >= 3 ? false : 2500;
    },
    shallow: true,
  });
}
