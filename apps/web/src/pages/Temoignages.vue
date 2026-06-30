<script setup lang="ts">
import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { LocationGroup, PublicTestimony } from "@ac/shared";
import { api } from "@/lib/api";
import GeoNav from "@/components/GeoNav.vue";

const testimoniesQuery = useQuery({
  queryKey: ["testimonies"],
  queryFn: () => api.get<PublicTestimony[]>("/api/testimonies"),
});

const testimonies = computed(() => testimoniesQuery.data.value ?? []);
const loading = computed(() => testimoniesQuery.isLoading.value);
const isError = computed(() => testimoniesQuery.isError.value);

// Map groups are server-side geocoded + cached; poll until the count stabilises
// (the warm pass resolves any not-yet-cached locations).
let mapStableTicks = 0;
let mapLastLen = -1;

const mapQuery = useQuery({
  queryKey: ["map"],
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
});

const groups = computed(() => mapQuery.data.value ?? []);
</script>

<template>
  <GeoNav :groups="groups" :testimonies="testimonies" :loading="loading" :is-error="isError" />
</template>
