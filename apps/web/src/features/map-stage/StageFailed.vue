<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ROUTE } from "@/shared/routes";

// The stage when the map's code could not be fetched (a flaky network): said,
// rather than a loading curtain left up for good. The link loads the page
// anew — a plain one, not the router's: a failed import is not tried again —
// at the address it is on, query and all. Only on the page: in the home
// card the opener (MapStage's link over it) is the retry, it leads to the
// page, and the card stays silent.

// The async wrapper hands over `preview` (the card) and `error` (the import's
// message, never shown): declared so that they are not left on the root as
// attributes.
defineOptions({ inheritAttrs: false });
defineProps<{ preview?: boolean; error?: unknown }>();

const route = useRoute();
const router = useRouter();
const pageHref = computed(
  () =>
    router.resolve(route.name === ROUTE.temoignages.name ? route : { name: ROUTE.temoignages.name })
      .href,
);
</script>

<template>
  <div class="stage-failed" :role="preview ? undefined : 'alert'">
    <p>La carte n'a pas pu être chargée.</p>
    <a v-if="!preview" :href="pageHref">Réessayer</a>
  </div>
</template>

<style scoped>
/* The box of StageLoading (GeoNav.vue's .boot). */
.stage-failed {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
  background: hsl(var(--background));
  color: hsl(var(--muted-foreground));
  font-size: var(--text-body);
}

.stage-failed a {
  color: hsl(var(--primary));
  font-weight: 600;
}
</style>
